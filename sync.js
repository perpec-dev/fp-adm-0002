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

  function avisar(){
    ouvintes.forEach(fn=>{ try{ fn({estado, perfil, pendentes:fila().length, erro:ultimoErro}); }catch(e){} });
  }
  function setEstado(e,msg){ estado=e; ultimoErro=msg||''; avisar(); }

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

  function perfilDoBanco(p){
    return { id:p.id, matricula:p.matricula, nome:p.nome, papel:p.papel,
             assinatura:p.assinatura||'', ativo:!!p.ativo, criadoEm:p.criado_em };
  }

  /* ---------------- inicialização e sessão ---------------- */
  async function iniciar(){
    if(!window.supabase || !CFG.SUPABASE_URL || /SEU-PROJETO/.test(CFG.SUPABASE_URL)){
      setEstado('erro','Conexão não configurada. Preencha o config.js.');
      return { configurado:false, sessao:null };
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
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
      .select('id,matricula,nome,papel,assinatura,ativo,criado_em')
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

  async function entrar(matricula, senha){
    if(!sb) throw new Error('Conexão não configurada.');
    const mat = soNumero(matricula);
    if(!mat)   throw new Error('Informe a matrícula.');
    if(!senha) throw new Error('Informe a senha.');

    const { error } = await sb.auth.signInWithPassword({ email:emailDe(mat), password:senha });
    if(error){
      // Mensagem genérica de propósito: não revela se a matrícula existe.
      throw new Error('Matrícula ou senha incorreta.');
    }
    const ok = await carregarPerfil();
    if(!ok) throw new Error(ultimoErro||'Não foi possível entrar.');
    return perfil;
  }

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
      const [reg, pfs] = await Promise.all([
        sb.from('registros').select(COLUNAS).order('entrada',{ascending:false}).limit(5000),
        sb.from('perfis').select('id,matricula,nome,papel,assinatura,ativo,criado_em').order('matricula')
      ]);
      if(reg.error) throw reg.error;
      if(pfs.error) throw pfs.error;
      localStorage.setItem(CHAVE_SYNC, new Date().toISOString());
      setEstado('ok');
      return { registros:reg.data.map(doBanco), perfis:pfs.data.map(perfilDoBanco), completo:true };
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
      const { data, error } = await sb.from('registros').select(COLUNAS)
        .gt('atualizado_em', desde).order('atualizado_em',{ascending:true}).limit(1000);
      if(error) throw error;
      localStorage.setItem(CHAVE_SYNC, new Date().toISOString());
      if(estado!=='ok') setEstado('ok');
      return { registros:data.map(doBanco), completo:false };
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

  function criarRegistro(r){   enfileirar('reg_insert', r);        return descarregar(); }
  function atualizarRegistro(r){ enfileirar('reg_update', r);      return descarregar(); }
  function apagarRegistro(id){ enfileirar('reg_delete', {id});     return descarregar(); }
  function auditar(registroId, evento, detalhe){
    enfileirar('aud_insert', { registro_id:registroId, evento, detalhe:detalhe||'',
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
            remover=true;
            setEstado('erro','Uma gravação foi recusada pelo servidor: '+(e.message||e.code));
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

  async function executar(item, mudouNumero){
    if(item.tipo==='reg_insert'){
      const r={...item.payload};
      // Registro criado offline recebe o número definitivo só agora.
      if(r.provisorio){
        const n=await numeroNovo();
        if(!n) throw new Error('network: sem numeração');
        mudouNumero.push({ id:r.id, de:r.numero, para:n });
        r.numero=n; r.provisorio=false;
      }
      const { error } = await sb.from('registros').insert(paraBanco(r));
      if(error) throw error;
    }
    else if(item.tipo==='reg_update'){
      const b=paraBanco(item.payload);
      const id=b.id;
      delete b.id;
      // A numeração é do servidor: um update nunca a altera. Se o registro
      // ainda era provisório quando a edição foi feita, quem corrige o
      // número é o insert que veio antes na fila.
      delete b.numero; delete b.provisorio;
      // documento nulo = "não mexer", não "apagar".
      if(b.documento===null) delete b.documento;
      const { error } = await sb.from('registros').update(b).eq('id', id);
      if(error) throw error;
    }
    else if(item.tipo==='reg_delete'){
      const { error } = await sb.from('registros').delete().eq('id', item.payload.id);
      if(error) throw error;
    }
    else if(item.tipo==='aud_insert'){
      const { error } = await sb.from('auditoria').insert(item.payload);
      if(error) throw error;
    }
    else if(item.tipo==='perfil_update'){
      const p=item.payload;
      const { error } = await sb.from('perfis').update(p.campos).eq('id', p.id);
      if(error) throw error;
    }
  }

  /* ---------------- perfis (gestor) ---------------- */
  async function criarPorteiro({matricula, nome, senha, papel, assinatura}){
    if(!sb) throw new Error('Sem conexão.');
    if(!perfil || perfil.papel!=='gestor') throw new Error('Somente gestores cadastram porteiros.');
    const mat=soNumero(matricula);
    if(!mat) throw new Error('Informe a matrícula.');
    if(String(nome||'').trim().length<5) throw new Error('Informe o nome completo.');
    if(String(senha||'').length<8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');

    // Cliente separado e descartável: criar o usuário não pode derrubar
    // a sessão do gestor que está cadastrando.
    const sbTmp = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth:{ persistSession:false, autoRefreshToken:false }
    });
    const { data, error } = await sbTmp.auth.signUp({ email:emailDe(mat), password:senha });
    if(error){
      if(/already/i.test(error.message||'')) throw new Error('Já existe usuário com a matrícula '+mat+'.');
      throw new Error(error.message);
    }
    const uid = data && data.user && data.user.id;
    if(!uid) throw new Error('Não foi possível criar o acesso. Verifique se a confirmação de e-mail está desligada no Supabase.');

    const { error:e2 } = await sb.from('perfis').insert({
      id:uid, matricula:mat, nome:String(nome).trim(),
      papel:(papel==='gestor'?'gestor':'porteiro'), assinatura:assinatura||null, ativo:true
    });
    if(e2) throw new Error('Acesso criado, mas o cadastro falhou: '+e2.message);

    return { id:uid, matricula:mat, nome:String(nome).trim(),
             papel:(papel==='gestor'?'gestor':'porteiro'), assinatura:assinatura||'', ativo:true };
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
    iniciar, entrar, sair, trocarSenha,
    puxarTudo, puxarNovidades, carregarAuditoria,
    criarRegistro, atualizarRegistro, apagarRegistro, auditar,
    descarregar, numeroNovo,
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
