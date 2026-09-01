/* ================================================================
   CAMADA DE DADOS — autenticação, sincronização e fila offline
   ----------------------------------------------------------------
   Expõe window.PORTARIA. O index.html não fala com o Supabase
   diretamente: tudo passa por aqui.

   COMO FUNCIONA
     - O servidor (Supabase) é a fonte da verdade.
     - O localStorage guarda uma CÓPIA para a tela abrir instantânea
       e para a portaria continuar trabalhando sem internet.
     - Toda gravação entra numa FILA (outbox). Ela é enviada na hora;
       se falhar, fica guardada e sobe sozinha quando a conexão voltar.
     - A leitura é atualizada por sondagem: incremental a cada 30 s e
       completa a cada 5 min (a completa também detecta exclusões).

   O QUE NÃO ESTÁ AQUI
     A senha nunca é guardada. O token de sessão fica no localStorage
     sob controle do próprio supabase-js e expira sozinho.
   ================================================================ */
window.PORTARIA = (function(){
  'use strict';

  const CFG        = window.SUPABASE_CONFIG || {};
  const CHAVE_FILA = 'perpec.portaria.outbox';
  const CHAVE_SYNC = 'perpec.portaria.ultimaSync';

  let sb       = null;     // cliente supabase-js
  let perfil   = null;     // perfil do usuário logado
  let estado   = 'offline';// 'offline' | 'sincronizando' | 'ok' | 'erro'
  let ultimoErro = '';
  const ouvintes = [];

  /* ---------------- utilidades ---------------- */
  const soNumero = v => String(v||'').replace(/\D/g,'').slice(0,10);
  const emailDe  = mat => soNumero(mat) + '@' + (CFG.DOMINIO_LOGIN||'portaria.perpec.local');

  /* O Supabase autentica por e-mail. Quem digita matrícula tem o e-mail
     interno montado aqui; quem tem e-mail de verdade (o gestor, por
     exemplo) usa o próprio. Os dois convivem no mesmo campo. */
  const ehEmail = v => /@/.test(String(v||''));
  function loginParaEmail(v){
    const s=String(v||'').trim();
    return ehEmail(s) ? s.toLowerCase() : emailDe(s);
  }

  function avisar(){
    ouvintes.forEach(fn=>{ try{ fn({estado, perfil, pendentes:fila().length, erro:ultimoErro}); }catch(e){} });
  }
  function setEstado(e,msg){ estado=e; ultimoErro=msg||''; avisar(); }

  /* ---------------- fotos pendentes (IndexedDB) ----------------
     Imagem não cabe no localStorage: uma foto comprimida tem ~200 KB e a
     cota inteira é de ~5 MB. As que ainda não subiram ficam aqui, e a fila
     do outbox guarda só a referência. */
  const IDB_NOME='perpec.portaria.fotos', IDB_STORE='pendentes';
  function idbAbrir(){
    return new Promise((res,rej)=>{
      const r=indexedDB.open(IDB_NOME,1);
      r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
      r.onsuccess=()=>res(r.result);
      r.onerror  =()=>rej(r.error);
    });
  }
  function idbOp(modo,fn){
    return idbAbrir().then(db=>new Promise((res,rej)=>{
      const t=db.transaction(IDB_STORE,modo), s=t.objectStore(IDB_STORE);
      let req; try{ req=fn(s); }catch(e){ rej(e); return; }
      // 'result' precisa ser testado por existência, não por valor: um get
      // que não achou nada devolve undefined, e devolver o próprio request
      // no lugar faria a checagem de "foto ausente" passar batido.
      t.oncomplete=()=>res(req && typeof req==='object' && 'result' in req ? req.result : undefined);
      t.onerror   =()=>rej(t.error);
    }));
  }
  const fotoGuardar = (id,dataUrl)=>idbOp('readwrite',s=>s.put(dataUrl,id));
  const fotoLer     = id          =>idbOp('readonly', s=>s.get(id));
  const fotoRemover = id          =>idbOp('readwrite',s=>s.delete(id));

  /* dataURL -> Blob, para subir como arquivo binário (não como texto). */
  function dataUrlParaBlob(dataUrl){
    const [cab,b64]=String(dataUrl).split(',');
    const mime=(cab.match(/data:([^;]+)/)||[,'image/jpeg'])[1];
    const bin=atob(b64), arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    return new Blob([arr],{type:mime});
  }
  function blobParaDataUrl(blob){
    return new Promise((res,rej)=>{
      const fr=new FileReader();
      fr.onload=()=>res(fr.result); fr.onerror=()=>rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  /* ---------------- fila offline (outbox) ---------------- */
  function fila(){
    try{ return JSON.parse(localStorage.getItem(CHAVE_FILA)||'[]'); }catch(e){ return []; }
  }
  function gravarFila(f){
    try{ localStorage.setItem(CHAVE_FILA, JSON.stringify(f)); }catch(e){}
  }
  function enfileirar(tipo,payload){
    const f=fila();
    f.push({ fid:'f'+Date.now().toString(36)+Math.random().toString(36).slice(2,6), tipo, payload, ts:new Date().toISOString() });
    gravarFila(f); avisar();
  }

  /* Quem ainda tem gravação esperando na fila.
     A tela usa isto para NÃO deixar a resposta do servidor sobrescrever esses
     registros: o que está no aparelho é mais novo do que o que está lá. Sem
     isso, registrar uma saída sem internet (ou logo antes de uma atualização)
     fazia o carro "voltar" para Estão dentro até a fila esvaziar. */
  function idsNaFila(){
    const regs=Object.create(null), rnds=Object.create(null);
    fila().forEach(i=>{
      const p=i.payload||{};
      if(i.tipo==='reg_insert'||i.tipo==='reg_update'||i.tipo==='reg_delete') regs[p.id]=true;
      else if(i.tipo==='ronda_insert'||i.tipo==='ronda_update') rnds[p.id]=true;
      else if(i.tipo==='obs_insert') rnds[p.rondaId]=true;
    });
    return { registros:Object.keys(regs), rondas:Object.keys(rnds) };
  }

  /* ---------------- tradução entre a tela e o banco ---------------- */
  // A tela usa camelCase; o banco usa snake_case.
  function paraBanco(r){
    return {
      id:r.id, numero:r.numero, provisorio:!!r.provisorio, status:r.status,
      pessoa:r.pessoa, documento:r.documento||null, empresa:r.empresa,
      placa:r.placa, veiculo:r.veiculo||null,
      entrada:r.entrada, saida:r.saida||null,
      setor:r.setor, autorizador:r.autorizador,
      porteiro_entrada:r.porteiroEntrada, matricula_entrada:r.matriculaEntrada, turno_entrada:r.turnoEntrada||null,
      porteiro_saida:r.porteiroSaida||null, matricula_saida:r.matriculaSaida||null, turno_saida:r.turnoSaida||null,
      observacoes:r.observacoes||null,
      confirm_entrada:r.confirmEntrada||null, confirm_saida:r.confirmSaida||null,
      selo:r.selo||null
    };
  }
  function doBanco(x){
    return {
      id:x.id, numero:x.numero, provisorio:!!x.provisorio, status:x.status,
      pessoa:x.pessoa,
      // O documento completo NUNCA chega aqui — o banco só entrega a máscara.
      documento:'', documentoMascarado:x.documento_mascarado||'',
      empresa:x.empresa, placa:x.placa, veiculo:x.veiculo||'',
      entrada:x.entrada, saida:x.saida,
      setor:x.setor, autorizador:x.autorizador,
      porteiroEntrada:x.porteiro_entrada, matriculaEntrada:x.matricula_entrada, turnoEntrada:x.turno_entrada||'',
      porteiroSaida:x.porteiro_saida, matriculaSaida:x.matricula_saida, turnoSaida:x.turno_saida||'',
      observacoes:x.observacoes||'',
      confirmEntrada:x.confirm_entrada, confirmSaida:x.confirm_saida,
      selo:x.selo||'', criadoEm:x.criado_em, atualizadoEm:x.atualizado_em,
      auditoria:null                       // carregada sob demanda ao abrir o registro
    };
  }
  const COLUNAS =
    'id,numero,provisorio,status,pessoa,documento_mascarado,empresa,placa,veiculo,entrada,saida,'+
    'setor,autorizador,porteiro_entrada,matricula_entrada,turno_entrada,porteiro_saida,matricula_saida,'+
    'turno_saida,observacoes,confirm_entrada,confirm_saida,selo,criado_em,atualizado_em';

  /* Colunas que o banco aceita ALTERAR num registro já criado.
     Quem liberou a entrada, quando e sob qual confirmação não muda depois:
     porteiro_entrada, matricula_entrada, turno_entrada e confirm_entrada não
     têm GRANT de UPDATE, de propósito.

     Isso não é detalhe: o Postgres recusa o UPDATE INTEIRO se UMA coluna sem
     permissão for citada, mesmo que o valor enviado seja igual ao que já está
     lá. O erro que volta é "permission denied for table registros" (42501) —
     genérico, sem dizer qual coluna. Por isso o envio monta o corpo a partir
     desta lista em vez de mandar o registro inteiro. */
  const COLUNAS_UPDATE = ['status','pessoa','documento','empresa','placa','veiculo',
                          'entrada','saida','setor','autorizador',
                          'porteiro_saida','matricula_saida','turno_saida',
                          'observacoes','confirm_saida','selo'];

  /* ---------------- ronda: tela <-> banco ---------------- */
  function paraBancoRonda(r){
    return {
      id:r.id, numero:r.numero, provisorio:!!r.provisorio, status:r.status,
      inicio:r.inicio, fim:r.fim||null,
      porteiro:r.porteiro, matricula:r.matricula, turno:r.turno||null,
      confirm:r.confirm||null, selo:r.selo||null
    };
  }
  function rondaDoBanco(x){
    return {
      id:x.id, numero:x.numero, provisorio:!!x.provisorio, status:x.status,
      inicio:x.inicio, fim:x.fim,
      porteiro:x.porteiro, matricula:x.matricula, turno:x.turno||'',
      confirm:x.confirm, selo:x.selo||'',
      criadoEm:x.criado_em, atualizadoEm:x.atualizado_em,
      observacoes:null              // penduradas depois, por rondaId
    };
  }
  function paraBancoObs(o){
    return { id:o.id, ronda_id:o.rondaId, ordem:o.ordem||0,
             local:o.local, descricao:o.descricao, ts:o.ts };
  }
  function obsDoBanco(o){
    return { id:o.id, rondaId:o.ronda_id, ordem:o.ordem, local:o.local,
             descricao:o.descricao, ts:o.ts, criadoEm:o.criado_em };
  }
  const COLUNAS_RONDA='id,numero,provisorio,status,inicio,fim,porteiro,matricula,turno,'+
                      'confirm,selo,criado_em,atualizado_em';
  const COLUNAS_OBS  ='id,ronda_id,ordem,local,descricao,ts,criado_em';
  // Ver o comentário de COLUNAS_UPDATE: citar coluna sem GRANT derruba o
  // UPDATE inteiro, então a lista é do que pode mudar.
  const COLUNAS_UPDATE_RONDA = ['status','fim','turno','confirm','selo'];

  function perfilDoBanco(p){
    return { id:p.id, matricula:p.matricula, nome:p.nome, papel:p.papel,
             assinatura:p.assinatura||'', ativo:!!p.ativo, criadoEm:p.criado_em };
  }
  // Não inclui login_email de propósito: assim o app funciona com o banco
  // criado antes dessa coluna existir. Quem autentica é o auth.users.
  const COLUNAS_PERFIL='id,matricula,nome,papel,assinatura,ativo,criado_em';

  /* A biblioteca já acrescenta /rest/v1, /auth/v1 etc. Se alguém colar a
     URL com esse caminho no fim, tira aqui em vez de quebrar tudo depois. */
  function urlBase(u){
    return String(u||'').trim()
      .replace(/\/+$/,'')
      .replace(/\/(rest|auth|storage|realtime)\/v1$/i,'')
      .replace(/\/+$/,'');
  }

  /* ---------------- inicialização e sessão ---------------- */
  async function iniciar(){
    const url = urlBase(CFG.SUPABASE_URL);
    const key = String(CFG.SUPABASE_ANON_KEY||'').trim();

    // Diagnóstico específico: mensagem genérica só faz perder tempo.
    let falta = null;
    if(!window.supabase)
      falta = 'A biblioteca do banco não carregou. Verifique a internet e se o navegador não está bloqueando o cdn.jsdelivr.net.';
    else if(!url || /SEU-PROJETO/i.test(url))
      falta = 'Falta o endereço do projeto no config.js (Supabase → Project Settings → Data API → Project URL).';
    else if(!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url))
      falta = 'O endereço no config.js parece errado: use só https://SEU-PROJETO.supabase.co, sem nada depois.';
    else if(!key || /COLE-AQUI/i.test(key))
      falta = 'Falta a chave "anon" no config.js (Supabase → Project Settings → API Keys → anon / public).';
    else if(/^eyJ/.test(key) === false && /^sb_/.test(key) === false)
      falta = 'A chave no config.js não parece a chave "anon" do Supabase. Copie de novo em API Keys.';

    if(falta){
      setEstado('erro', falta);
      return { configurado:false, sessao:null, motivo:falta };
    }

    sb = window.supabase.createClient(url, key, {
      auth:{ persistSession:true, autoRefreshToken:true, storageKey:'perpec.portaria.auth' }
    });

    // Sessão expirada ou revogada derruba o usuário para a tela de entrada.
    sb.auth.onAuthStateChange((evt)=>{ if(evt==='SIGNED_OUT'){ perfil=null; avisar(); } });

    const { data } = await sb.auth.getSession();
    if(data && data.session){
      const ok = await carregarPerfil();
      if(!ok) return { configurado:true, sessao:null };
      return { configurado:true, sessao:perfil };
    }
    return { configurado:true, sessao:null };
  }

  async function carregarPerfil(){
    const { data:u } = await sb.auth.getUser();
    if(!u || !u.user){ perfil=null; return false; }
    const { data, error } = await sb.from('perfis')
      .select(COLUNAS_PERFIL)
      .eq('id', u.user.id).maybeSingle();
    if(error || !data){
      // Usuário existe no Auth mas não tem cadastro liberado.
      await sb.auth.signOut(); perfil=null;
      setEstado('erro','Seu usuário ainda não foi liberado por um gestor.');
      return false;
    }
    if(!data.ativo){
      await sb.auth.signOut(); perfil=null;
      setEstado('erro','Seu cadastro está desativado. Procure o gestor.');
      return false;
    }
    perfil = perfilDoBanco(data);
    setEstado('ok');
    return true;
  }

  async function entrar(identificador, senha){
    if(!sb) throw new Error('Conexão não configurada.');
    const id = String(identificador||'').trim();
    if(!id)    throw new Error('Informe a matrícula ou o e-mail.');
    if(!ehEmail(id) && !soNumero(id)) throw new Error('Informe a matrícula (só números) ou o e-mail completo.');
    if(!senha) throw new Error('Informe a senha.');

    const login = loginParaEmail(id);
    const { error } = await sb.auth.signInWithPassword({ email:login, password:senha });
    if(error){
      const m = String(error.message||'');
      const cod = String(error.code||'');

      // Credencial errada mesmo: mensagem genérica de propósito, para não
      // revelar a quem tentar adivinhar se a matrícula existe.
      if(/invalid.*credential|invalid login/i.test(m) || cod==='invalid_credentials')
        throw new Error(ehEmail(id) ? 'E-mail ou senha incorreta.' : 'Matrícula ou senha incorreta.');

      if(/invalid api key/i.test(m))
        throw new Error('A chave ou o endereço no config.js estão errados.\n'+
                        'Confira se SUPABASE_URL é só https://SEU-PROJETO.supabase.co, sem "/rest/v1/".');

      // Os demais são erros de INSTALAÇÃO. Esconder atrapalha e não protege nada.
      if(/email not confirmed|not_confirmed/i.test(m))
        throw new Error('O usuário existe, mas está marcado como não confirmado.\n'+
                        'Desligue "Confirm email" em Authentication → Providers → Email e '+
                        'confirme o usuário em Authentication → Users.');
      if(/email.*(invalid|not valid)|invalid.*email/i.test(m))
        throw new Error('O Supabase recusou o e-mail "'+login+'".\n'+
                        (ehEmail(id) ? 'Confira se está escrito corretamente.'
                                     : 'Troque DOMINIO_LOGIN no config.js por um domínio comum '+
                                       '(ex.: portaria.perpec.com.br) e recadastre os usuários com esse domínio.'));
      if(/disabled|not enabled|signups?/i.test(m))
        throw new Error('O login por e-mail/senha está desligado no projeto.\n'+
                        'Ligue em Authentication → Providers → Email.');

      throw new Error('Não consegui entrar: '+m+(cod?'  ['+cod+']':''));
    }
    const ok = await carregarPerfil();
    if(!ok) throw new Error(ultimoErro||'Não foi possível entrar.');
    return perfil;
  }

  /* Usado pela tela para mostrar exatamente qual e-mail está sendo tentado —
     é a checagem mais rápida contra erro de digitação no cadastro. */
  function emailDeMatricula(v){ return loginParaEmail(v); }

  async function sair(){
    if(fila().length && !confirm('Ainda há '+fila().length+' registro(s) esperando envio.\nSair mesmo assim?')) return false;
    if(sb) await sb.auth.signOut();
    perfil=null; setEstado('offline');
    return true;
  }

  async function trocarSenha(nova){
    if(!sb) throw new Error('Sem conexão.');
    if(String(nova||'').length<8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
    const { error } = await sb.auth.updateUser({ password:nova });
    if(error) throw new Error(error.message);
    return true;
  }

  /* ---------------- leitura ---------------- */
  async function puxarTudo(){
    if(!sb || !perfil) return null;
    setEstado('sincronizando');
    try{
      const [reg, pfs, rnd, obs] = await Promise.all([
        sb.from('registros').select(COLUNAS).order('entrada',{ascending:false}).limit(5000),
        sb.from('perfis').select(COLUNAS_PERFIL).order('matricula'),
        sb.from('rondas').select(COLUNAS_RONDA).order('inicio',{ascending:false}).limit(2000),
        sb.from('observacoes').select(COLUNAS_OBS).order('ronda_id').order('ordem').limit(20000)
      ]);
      if(reg.error) throw reg.error;
      if(pfs.error) throw pfs.error;
      if(rnd.error) throw rnd.error;
      if(obs.error) throw obs.error;
      localStorage.setItem(CHAVE_SYNC, new Date().toISOString());
      setEstado('ok');
      return { registros:reg.data.map(doBanco), perfis:pfs.data.map(perfilDoBanco),
               rondas:rnd.data.map(rondaDoBanco), observacoes:obs.data.map(obsDoBanco),
               completo:true };
    }catch(e){
      setEstado('offline', e.message||'Sem conexão');
      return null;
    }
  }

  async function puxarNovidades(){
    if(!sb || !perfil) return null;
    const desde = localStorage.getItem(CHAVE_SYNC);
    if(!desde) return puxarTudo();
    try{
      // Observação não tem "atualizado_em" porque nunca é editada: o
      // critério é quando ela chegou ao servidor.
      const [reg, rnd, obs] = await Promise.all([
        sb.from('registros').select(COLUNAS)
          .gt('atualizado_em', desde).order('atualizado_em',{ascending:true}).limit(1000),
        sb.from('rondas').select(COLUNAS_RONDA)
          .gt('atualizado_em', desde).order('atualizado_em',{ascending:true}).limit(1000),
        sb.from('observacoes').select(COLUNAS_OBS)
          .gt('criado_em', desde).order('criado_em',{ascending:true}).limit(5000)
      ]);
      if(reg.error) throw reg.error;
      if(rnd.error) throw rnd.error;
      if(obs.error) throw obs.error;
      localStorage.setItem(CHAVE_SYNC, new Date().toISOString());
      if(estado!=='ok') setEstado('ok');
      return { registros:reg.data.map(doBanco), rondas:rnd.data.map(rondaDoBanco),
               observacoes:obs.data.map(obsDoBanco), completo:false };
    }catch(e){
      setEstado('offline', e.message||'Sem conexão');
      return null;
    }
  }

  async function carregarAuditoria(registroId){
    if(!sb || !perfil) return [];
    const { data, error } = await sb.from('auditoria')
      .select('ts,evento,detalhe,autor,matricula')
      .eq('registro_id', registroId).order('ts',{ascending:true});
    if(error) return [];
    return data.map(a=>({ ts:a.ts, evento:a.evento, detalhe:a.detalhe||'', autor:a.autor,
                          matricula:a.matricula||'' }));
  }

  /* ---------------- escrita (sempre pela fila) ---------------- */
  async function numeroNovo(){
    if(!sb) return null;
    const { data, error } = await sb.rpc('proximo_numero');
    if(error) return null;
    return data;
  }
  async function numeroNovoRonda(){
    if(!sb) return null;
    const { data, error } = await sb.rpc('proximo_numero_ronda');
    if(error) return null;
    return data;
  }

  /* ---------------- fotos ----------------
     A imagem vai para o IndexedDB e a fila leva só a referência. Assim uma
     entrada com 6 fotos não estoura o localStorage nem trava a fila. */
  async function anexarFoto(registroId, momento, dataUrl, ordem, marcada){
    const fotoId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
                 : 'f'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
    await fotoGuardar(fotoId, dataUrl);
    enfileirar('foto_upload', { fotoId, registroId, momento, ordem:ordem||0, marcada:!!marcada });
    descarregar();
    return fotoId;
  }

  async function listarFotos(registroId){
    if(!sb || !perfil) return [];
    const { data, error } = await sb.from('fotos')
      .select('id,registro_id,momento,caminho,ordem,marcada,criado_em')
      .eq('registro_id', registroId).order('momento').order('ordem');
    if(error || !data || !data.length) return [];

    // Bucket privado: cada exibição usa uma URL assinada de curta duração.
    const { data:urls } = await sb.storage.from('fotos')
      .createSignedUrls(data.map(f=>f.caminho), 3600);
    const porCaminho={};
    (urls||[]).forEach(u=>{ if(u && u.path) porCaminho[u.path]=u.signedUrl; });
    return data.map(f=>({ id:f.id, momento:f.momento, caminho:f.caminho, ordem:f.ordem,
                          marcada:f.marcada, url:porCaminho[f.caminho]||'' }));
  }

  /* Bytes reais da foto — usado pelo PDF, que não aceita URL remota. */
  async function baixarFoto(caminho){
    if(!sb) return null;
    const { data, error } = await sb.storage.from('fotos').download(caminho);
    if(error || !data) return null;
    try{ return await blobParaDataUrl(data); }catch(e){ return null; }
  }

  async function apagarFoto(id, caminho){
    if(!sb) throw new Error('Sem conexão.');
    const { error } = await sb.from('fotos').delete().eq('id', id);
    if(error) throw new Error(error.message);
    await sb.storage.from('fotos').remove([caminho]);   // órfão no bucket não é crítico
    return true;
  }

  /* ---------------- fotos de observação de ronda ----------------
     Mesmo bucket e mesma tabela das fotos de veículo; muda o dono da
     foto (observacao_id em vez de registro_id) e a pasta no Storage. */
  async function anexarFotoObs(rondaId, obsId, dataUrl, ordem, marcada){
    const fotoId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
                 : 'f'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
    await fotoGuardar(fotoId, dataUrl);
    enfileirar('foto_obs_upload', { fotoId, rondaId, obsId, ordem:ordem||0, marcada:!!marcada });
    descarregar();
    return fotoId;
  }

  /* Todas as fotos das observações de uma ronda, agrupadas por observação. */
  async function listarFotosDaRonda(obsIds){
    if(!sb || !perfil || !obsIds || !obsIds.length) return {};
    const { data, error } = await sb.from('fotos')
      .select('id,observacao_id,caminho,ordem,marcada,criado_em')
      .in('observacao_id', obsIds).order('ordem');
    if(error || !data || !data.length) return {};

    const { data:urls } = await sb.storage.from('fotos')
      .createSignedUrls(data.map(f=>f.caminho), 3600);
    const porCaminho={};
    (urls||[]).forEach(u=>{ if(u && u.path) porCaminho[u.path]=u.signedUrl; });

    const porObs={};
    data.forEach(f=>{
      (porObs[f.observacao_id] = porObs[f.observacao_id] || []).push({
        id:f.id, caminho:f.caminho, ordem:f.ordem, marcada:f.marcada,
        url:porCaminho[f.caminho]||''
      });
    });
    return porObs;
  }

  /* Quantas fotos ainda não subiram (para a tela avisar). */
  function fotosPendentes(registroId){
    return fila().filter(i=>i.tipo==='foto_upload' &&
      (!registroId || i.payload.registroId===registroId)).length;
  }
  function fotosRondaPendentes(rondaId){
    return fila().filter(i=>i.tipo==='foto_obs_upload' &&
      (!rondaId || i.payload.rondaId===rondaId)).length;
  }

  function criarRegistro(r){   enfileirar('reg_insert', r);        return descarregar(); }
  function atualizarRegistro(r){ enfileirar('reg_update', r);      return descarregar(); }
  function apagarRegistro(id){ enfileirar('reg_delete', {id});     return descarregar(); }
  function criarRonda(r){      enfileirar('ronda_insert', r);      return descarregar(); }
  function atualizarRonda(r){  enfileirar('ronda_update', r);      return descarregar(); }
  function criarObservacao(o){ enfileirar('obs_insert', o);        return descarregar(); }
  function auditar(registroId, evento, detalhe){
    enfileirar('aud_insert', { registro_id:registroId, evento, detalhe:detalhe||'',
                               autor:(perfil&&perfil.nome)||'—', matricula:(perfil&&perfil.matricula)||null });
    return descarregar();
  }
  function auditarRonda(rondaId, evento, detalhe){
    enfileirar('aud_insert', { ronda_id:rondaId, evento, detalhe:detalhe||'',
                               autor:(perfil&&perfil.nome)||'—', matricula:(perfil&&perfil.matricula)||null });
    return descarregar();
  }

  /* Envia a fila em ordem. Para no primeiro erro de rede (para não
     inverter a ordem dos eventos); erros permanentes são descartados
     com aviso, senão a fila travaria para sempre. */
  let enviando=false;
  async function descarregar(){
    if(enviando || !sb || !perfil) return { enviados:0, pendentes:fila().length };
    enviando=true;
    let enviados=0, mudouNumero=[];
    try{
      // A fila é relida do armazenamento a cada volta: uma gravação nova
      // pode entrar enquanto o envio acontece, e não pode ser perdida.
      while(true){
        const f=fila();
        if(!f.length) break;
        const item=f[0];
        let remover=false;
        try{
          await executar(item, mudouNumero);
          remover=true; enviados++;
        }catch(e){
          const permanente = e && e.code && !/fetch|network|Failed/i.test(e.message||'');
          if(permanente){
            // Ex.: violação de regra de acesso. Reenviar não adianta.
            // O item sai da fila, e o que estava na tela volta a ser o que o
            // servidor tem. Precisa ficar claro O QUE não foi gravado, senão
            // o registro só "some" e ninguém entende.
            remover=true;
            setEstado('erro', descreverFalha(item)+' não foi gravado no servidor: '+
                              (e.message||e.code));
          }else{
            setEstado('offline','Sem conexão — '+f.length+' na fila');
            break;
          }
        }
        if(remover){
          const atual=fila();
          const i=atual.findIndex(x=>x.fid===item.fid);
          if(i>=0){ atual.splice(i,1); gravarFila(atual); }
        }
      }
      if(!fila().length && estado!=='erro') setEstado('ok');
    } finally {
      enviando=false; avisar();
    }
    return { enviados, pendentes:fila().length, mudouNumero };
  }

  /* Nome em português do que a fila estava tentando gravar, para a mensagem
     de erro dizer algo além de "reg_update". */
  function descreverFalha(item){
    const p=item.payload||{};
    switch(item.tipo){
      case 'reg_insert':      return 'A entrada '+(p.numero||'');
      case 'reg_update':      return 'A alteração do registro '+(p.numero||'');
      case 'reg_delete':      return 'A exclusão do registro';
      case 'ronda_insert':    return 'A ronda '+(p.numero||'');
      case 'ronda_update':    return 'A alteração da ronda '+(p.numero||'');
      case 'obs_insert':      return 'A observação de ronda "'+(p.local||'')+'"';
      case 'foto_upload':
      case 'foto_obs_upload': return 'Uma foto';
      case 'aud_insert':      return 'Um evento do histórico';
      case 'perfil_update':   return 'A alteração do cadastro';
      default:                return 'Uma gravação';
    }
  }

  async function executar(item, mudouNumero){
    if(item.tipo==='reg_insert'){
      const r={...item.payload};
      // Registro criado offline recebe o número definitivo só agora.
      if(r.provisorio){
        const n=await numeroNovo();
        if(!n) throw new Error('network: sem numeração');
        mudouNumero.push({ tipo:'registro', id:r.id, de:r.numero, para:n });
        r.numero=n; r.provisorio=false;
        // O número entra no selo. Trocar o provisório pelo definitivo sem
        // re-selar faria o registro nascer no servidor já "adulterado".
        if(typeof window.selarRegistro==='function') window.selarRegistro(r);
      }
      const { error } = await sb.from('registros').insert(paraBanco(r));
      if(error) throw error;
    }
    else if(item.tipo==='reg_update'){
      const todo=paraBanco(item.payload);
      const id=todo.id;
      // Só o que o banco deixa alterar. A numeração é do servidor: um update
      // nunca a altera — se o registro ainda era provisório quando a edição
      // foi feita, quem corrige o número é o insert que veio antes na fila.
      const b={};
      COLUNAS_UPDATE.forEach(k=>{ if(k in todo) b[k]=todo[k]; });
      // documento nulo = "não mexer", não "apagar".
      if(b.documento===null) delete b.documento;
      const { error } = await sb.from('registros').update(b).eq('id', id);
      if(error) throw error;
    }
    else if(item.tipo==='reg_delete'){
      const { error } = await sb.from('registros').delete().eq('id', item.payload.id);
      if(error) throw error;
    }
    else if(item.tipo==='ronda_insert'){
      const r={...item.payload};
      // Ronda aberta sem internet recebe o número definitivo só agora.
      if(r.provisorio){
        const n=await numeroNovoRonda();
        if(!n) throw new Error('network: sem numeração');
        mudouNumero.push({ tipo:'ronda', id:r.id, de:r.numero, para:n });
        r.numero=n; r.provisorio=false;
        if(typeof window.selarRonda==='function') window.selarRonda(r);
      }
      const { error } = await sb.from('rondas').insert(paraBancoRonda(r));
      if(error) throw error;
    }
    else if(item.tipo==='ronda_update'){
      const todo=paraBancoRonda(item.payload);
      const id=todo.id;
      // Mesma regra dos registros: lista do que PODE mudar, não lista do que
      // não pode. Início, porteiro e matrícula não mudam depois de a ronda ser
      // aberta, e o banco não dá permissão nessas colunas.
      const b={};
      COLUNAS_UPDATE_RONDA.forEach(k=>{ if(k in todo) b[k]=todo[k]; });
      const { error } = await sb.from('rondas').update(b).eq('id', id);
      if(error) throw error;
    }
    else if(item.tipo==='obs_insert'){
      const { error } = await sb.from('observacoes').insert(paraBancoObs(item.payload));
      if(error && !/duplicate|unique/i.test(error.message||'')) throw error;
    }
    else if(item.tipo==='aud_insert'){
      const { error } = await sb.from('auditoria').insert(item.payload);
      if(error) throw error;
    }
    else if(item.tipo==='foto_obs_upload'){
      const p=item.payload;
      const dataUrl=await fotoLer(p.fotoId);
      if(!dataUrl){
        const e=new Error('Foto não está mais neste aparelho.'); e.code='foto_ausente'; throw e;
      }
      const caminho = 'rondas/'+p.rondaId+'/'+p.obsId+'-'+String(p.ordem).padStart(2,'0')+'-'+p.fotoId+'.jpg';
      const { error:eUp } = await sb.storage.from('fotos')
        .upload(caminho, dataUrlParaBlob(dataUrl), { contentType:'image/jpeg', upsert:false });
      if(eUp && !/exists|duplicate/i.test(eUp.message||'')) throw eUp;

      const { error:eIns } = await sb.from('fotos').insert({
        id:p.fotoId, observacao_id:p.obsId, momento:'observacao',
        caminho, ordem:p.ordem, marcada:!!p.marcada
      });
      if(eIns && !/duplicate|unique/i.test(eIns.message||'')) throw eIns;

      await fotoRemover(p.fotoId);
    }
    else if(item.tipo==='foto_upload'){
      const p=item.payload;
      const dataUrl=await fotoLer(p.fotoId);
      if(!dataUrl){
        // Cache do aparelho foi limpo antes do envio: nada a fazer, e
        // insistir travaria a fila para sempre.
        const e=new Error('Foto não está mais neste aparelho.'); e.code='foto_ausente'; throw e;
      }
      const caminho = p.registroId+'/'+p.momento+'-'+String(p.ordem).padStart(2,'0')+'-'+p.fotoId+'.jpg';
      const { error:eUp } = await sb.storage.from('fotos')
        .upload(caminho, dataUrlParaBlob(dataUrl), { contentType:'image/jpeg', upsert:false });
      // "already exists" = reenvio de um item que já subiu; segue em frente.
      if(eUp && !/exists|duplicate/i.test(eUp.message||'')) throw eUp;

      const { error:eIns } = await sb.from('fotos').insert({
        id:p.fotoId, registro_id:p.registroId, momento:p.momento,
        caminho, ordem:p.ordem, marcada:!!p.marcada
      });
      if(eIns && !/duplicate|unique/i.test(eIns.message||'')) throw eIns;

      await fotoRemover(p.fotoId);
    }
    else if(item.tipo==='perfil_update'){
      const p=item.payload;
      const { error } = await sb.from('perfis').update(p.campos).eq('id', p.id);
      if(error) throw error;
    }
  }

  /* ---------------- perfis (gestor) ---------------- */
  async function criarPorteiro({matricula, nome, senha, papel, assinatura, email}){
    if(!sb) throw new Error('Sem conexão.');
    if(!perfil || perfil.papel!=='gestor') throw new Error('Somente gestores cadastram porteiros.');
    const mat=soNumero(matricula);
    if(!mat) throw new Error('Informe a matrícula.');
    if(String(nome||'').trim().length<5) throw new Error('Informe o nome completo.');
    if(String(senha||'').length<8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');

    // E-mail real (opcional) tem precedência; senão usa o interno da matrícula.
    const mail = String(email||'').trim().toLowerCase();
    if(mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('E-mail inválido.');
    const login = mail || emailDe(mat);

    // Cliente separado e descartável: criar o usuário não pode derrubar
    // a sessão do gestor que está cadastrando.
    const sbTmp = window.supabase.createClient(urlBase(CFG.SUPABASE_URL), String(CFG.SUPABASE_ANON_KEY||'').trim(), {
      auth:{ persistSession:false, autoRefreshToken:false }
    });
    const { data, error } = await sbTmp.auth.signUp({ email:login, password:senha });
    if(error){
      if(/already/i.test(error.message||'')) throw new Error('Já existe usuário com o acesso '+login+'.');
      throw new Error(error.message);
    }
    const uid = data && data.user && data.user.id;
    if(!uid) throw new Error('Não foi possível criar o acesso. Verifique se a confirmação de e-mail está desligada no Supabase.');

    const novo={ id:uid, matricula:mat, nome:String(nome).trim(),
                 papel:(papel==='gestor'?'gestor':'porteiro'),
                 assinatura:assinatura||null, ativo:true };
    const { error:e2 } = await sb.from('perfis').insert(novo);
    if(e2) throw new Error('Acesso criado, mas o cadastro falhou: '+e2.message);

    return Object.assign({}, novo, { assinatura:assinatura||'' });
  }

  async function salvarPerfil(id, campos){
    if(!sb) throw new Error('Sem conexão.');
    const { error } = await sb.from('perfis').update(campos).eq('id', id);
    if(error) throw new Error(error.message);
    if(perfil && perfil.id===id) Object.assign(perfil, campos);
    avisar();
    return true;
  }

  async function apagarPerfil(id){
    if(!sb) throw new Error('Sem conexão.');
    const { error } = await sb.from('perfis').delete().eq('id', id);
    if(error) throw new Error(error.message);
    return true;
  }

  /* ---------------- documento sensível ---------------- */
  async function revelarDocumento(registroId){
    if(!sb) throw new Error('Sem conexão.');
    const { data, error } = await sb.rpc('revelar_documento', { p_registro:registroId });
    if(error) throw new Error(error.message||'Consulta não autorizada.');
    return data;
  }

  async function anonimizarAntigos(meses){
    if(!sb) throw new Error('Sem conexão.');
    const { data, error } = await sb.rpc('anonimizar_antigos', { p_meses:meses });
    if(error) throw new Error(error.message);
    return data;
  }

  /* ---------------- ciclo automático ---------------- */
  let timers=[];
  function ligarSondagem(aoReceber){
    desligarSondagem();
    const incremental = async ()=>{
      const r=await puxarNovidades();
      if(r && aoReceber) aoReceber(r);
      await descarregar();
    };
    const completa = async ()=>{
      const r=await puxarTudo();
      if(r && aoReceber) aoReceber(r);
    };
    timers.push(setInterval(incremental, 30000));
    timers.push(setInterval(completa,   300000));
    window.addEventListener('online',  incremental);
    window.addEventListener('focus',   incremental);
    window.addEventListener('offline', ()=>setEstado('offline','Sem conexão'));
  }
  function desligarSondagem(){ timers.forEach(clearInterval); timers=[]; }

  /* ---------------- API pública ---------------- */
  return {
    iniciar, entrar, sair, trocarSenha, emailDeMatricula,
    puxarTudo, puxarNovidades, carregarAuditoria,
    criarRegistro, atualizarRegistro, apagarRegistro, auditar,
    criarRonda, atualizarRonda, criarObservacao, auditarRonda,
    anexarFoto, listarFotos, baixarFoto, apagarFoto, fotosPendentes,
    anexarFotoObs, listarFotosDaRonda, fotosRondaPendentes,
    descarregar, numeroNovo, numeroNovoRonda, idsNaFila,
    criarPorteiro, salvarPerfil, apagarPerfil,
    revelarDocumento, anonimizarAntigos,
    ligarSondagem, desligarSondagem,
    aoMudar(fn){ ouvintes.push(fn); },
    get perfil(){ return perfil; },
    get estado(){ return estado; },
    get pendentes(){ return fila().length; },
    get online(){ return navigator.onLine && estado==='ok'; },
    get gestor(){ return !!perfil && perfil.papel==='gestor'; }
  };
})();
