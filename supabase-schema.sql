-- =====================================================================
-- CONTROLE DE ENTRADA DE VEÍCULOS — PORTARIA
-- Esquema do banco de dados (Supabase / PostgreSQL)
-- FP-ADM-0002 · Perpec Oilfield Supply
-- ---------------------------------------------------------------------
-- COMO USAR
--   1. Crie o projeto no Supabase, região South America (São Paulo).
--   2. Abra  SQL Editor → New query,  cole este arquivo inteiro e rode.
--   3. Em  Authentication → Providers → Email,  DESLIGUE "Confirm email"
--      (o login é por matrícula, não existe caixa de e-mail real).
--   4. Crie o primeiro usuário gestor — ver o bloco PRIMEIRO GESTOR
--      no fim deste arquivo.
--
-- PRINCÍPIO DE SEGURANÇA
--   A página é pública (GitHub Pages) e a chave "anon" fica visível no
--   código. Isso é seguro PORQUE nada neste banco é acessível sem uma
--   sessão autenticada: toda tabela tem Row Level Security ligada e
--   nenhuma política concede acesso ao papel "anon".
--   O campo DOCUMENTO (RG/CPF) é o dado mais sensível e recebe proteção
--   extra: ninguém consegue lê-lo pela API. A tela mostra apenas a
--   versão mascarada, e o valor completo só sai pela função
--   revelar_documento(), exclusiva de gestores e registrada em auditoria.
-- =====================================================================

create extension if not exists pgcrypto;


-- =====================================================================
-- 1. PERFIS  — cadastro de porteiros e gestores
--    Um perfil por usuário do Auth. A matrícula é a chave que a pessoa
--    digita para entrar; o e-mail interno derivado dela nunca é usado
--    para receber mensagens.
-- =====================================================================
create table if not exists public.perfis (
  id            uuid primary key references auth.users(id) on delete cascade,
  matricula     text not null unique check (matricula ~ '^[0-9]{1,10}$'),
  nome          text not null check (char_length(btrim(nome)) >= 5),
  papel         text not null default 'porteiro' check (papel in ('porteiro','gestor')),
  assinatura    text,                       -- PNG em base64 (data URI)
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on table  public.perfis is 'Porteiros e gestores. A matrícula é o login padrão.';
comment on column public.perfis.assinatura is 'Assinatura desenhada, PNG base64. Sai nos PDFs.';


-- =====================================================================
-- 2. FUNÇÕES DE APOIO
--    security definer para poderem ler public.perfis sem cair na própria
--    RLS (evita recursão infinita nas políticas).
-- =====================================================================
create or replace function public.sou_ativo()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select ativo from public.perfis where id = auth.uid()), false)
$$;

create or replace function public.sou_gestor()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select papel = 'gestor' and ativo from public.perfis where id = auth.uid()), false)
$$;

create or replace function public.minha_matricula()
returns text language sql stable security definer set search_path = public as $$
  select matricula from public.perfis where id = auth.uid() and ativo
$$;

create or replace function public.meu_nome()
returns text language sql stable security definer set search_path = public as $$
  select nome from public.perfis where id = auth.uid() and ativo
$$;


-- =====================================================================
-- 3. REGISTROS  — entradas e saídas
-- =====================================================================
create table if not exists public.registros (
  id                uuid primary key default gen_random_uuid(),
  numero            text not null unique,
  provisorio        boolean not null default false,   -- criado offline, numeração ainda não definitiva
  status            text not null default 'aberto' check (status in ('aberto','concluido')),

  -- quem entrou
  pessoa            text not null check (char_length(btrim(pessoa)) >= 3),
  documento         text,                             -- SENSÍVEL: sem permissão de leitura pela API
  empresa           text not null check (char_length(btrim(empresa)) >= 1),

  -- veículo
  placa             text not null,
  veiculo           text,

  -- movimentação
  entrada           timestamptz not null,
  saida             timestamptz,

  -- autorização
  setor             text not null,
  autorizador       text not null,

  -- responsáveis
  porteiro_entrada  text not null,
  matricula_entrada text not null,
  turno_entrada     text,
  porteiro_saida    text,
  matricula_saida   text,
  turno_saida       text,

  observacoes       text,
  confirm_entrada   jsonb,
  confirm_saida     jsonb,
  selo              text,

  criado_em         timestamptz not null default now(),
  criado_por        uuid not null default auth.uid(),
  atualizado_em     timestamptz not null default now(),
  atualizado_por    uuid not null default auth.uid(),

  -- Versão mascarada do documento: é ela que a tela recebe.
  documento_mascarado text generated always as (
    case
      when documento is null or btrim(documento) = '' then null
      when char_length(btrim(documento)) <= 4 then repeat('•', char_length(btrim(documento)))
      else repeat('•', char_length(btrim(documento)) - 4) || right(btrim(documento), 4)
    end
  ) stored,

  constraint placa_valida check (
    placa ~ '^[A-Z]{3}[0-9][A-Z][0-9]{2}$' or placa ~ '^[A-Z]{3}[0-9]{4}$'
  ),
  constraint saida_depois_da_entrada check (saida is null or saida >= entrada)
);

create index if not exists registros_entrada_idx      on public.registros (entrada desc);
create index if not exists registros_status_idx       on public.registros (status);
create index if not exists registros_placa_idx        on public.registros (placa);
create index if not exists registros_atualizado_idx   on public.registros (atualizado_em desc);

comment on column public.registros.documento is
  'RG/CPF do visitante. Sem GRANT de SELECT: só sai por revelar_documento(), que é gestor-only e auditada.';


-- =====================================================================
-- 3b. FOTOS  — anexos opcionais da entrada e da saída
--     A imagem em si vai para o Storage (bucket "fotos"); aqui fica só
--     o caminho e a quem pertence.
-- =====================================================================
create table if not exists public.fotos (
  id           uuid primary key default gen_random_uuid(),
  registro_id  uuid not null references public.registros(id) on delete cascade,
  momento      text not null check (momento in ('entrada','saida')),
  caminho      text not null unique,          -- caminho dentro do bucket
  ordem        integer not null default 0,
  marcada      boolean not null default false,-- true = tem riscos/setas do porteiro
  criado_em    timestamptz not null default now(),
  criado_por   uuid not null default auth.uid()
);
create index if not exists fotos_registro_idx on public.fotos (registro_id, momento, ordem);

comment on table public.fotos is
  'Fotos anexadas na entrada ou na saída. O arquivo fica no bucket "fotos" do Storage.';


-- =====================================================================
-- 4. AUDITORIA  — só cresce, ninguém edita nem apaga pela API
-- =====================================================================
create table if not exists public.auditoria (
  id          bigint generated always as identity primary key,
  registro_id uuid references public.registros(id) on delete cascade,
  ts          timestamptz not null default now(),
  evento      text not null,
  detalhe     text,
  autor       text not null,
  matricula   text,
  autor_id    uuid not null default auth.uid()
);

create index if not exists auditoria_registro_idx on public.auditoria (registro_id, ts);


-- =====================================================================
-- 5. NUMERAÇÃO SEQUENCIAL POR ANO
--    Feita no servidor: dois aparelhos registrando ao mesmo tempo nunca
--    recebem o mesmo número.
-- =====================================================================
create table if not exists public.contadores (
  ano    integer primary key,
  ultimo integer not null default 0
);

create or replace function public.proximo_numero()
returns text language plpgsql security definer set search_path = public as $$
declare
  v_ano integer := extract(year from now() at time zone 'America/Sao_Paulo');
  v_n   integer;
begin
  if not public.sou_ativo() then
    raise exception 'Usuário sem permissão.';
  end if;

  insert into public.contadores (ano, ultimo) values (v_ano, 1)
    on conflict (ano) do update set ultimo = public.contadores.ultimo + 1
    returning ultimo into v_n;

  return 'PORT-' || v_ano || '-' || lpad(v_n::text, 4, '0');
end $$;


-- =====================================================================
-- 6. LEITURA DO DOCUMENTO COMPLETO  — gestor apenas, sempre auditada
-- =====================================================================
create or replace function public.revelar_documento(p_registro uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_doc text;
begin
  if not public.sou_gestor() then
    raise exception 'Somente gestores podem ver o documento completo.';
  end if;

  select documento into v_doc from public.registros where id = p_registro;

  insert into public.auditoria (registro_id, evento, detalhe, autor, matricula)
  values (p_registro, 'DOCUMENTO CONSULTADO',
          'Documento completo do visitante exibido.',
          coalesce(public.meu_nome(), '—'), public.minha_matricula());

  return v_doc;
end $$;


-- =====================================================================
-- 7. GATILHOS DE INTEGRIDADE
-- =====================================================================

-- 7.1 carimba quem alterou e quando
create or replace function public.tg_carimbo()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.atualizado_em  := now();
  new.atualizado_por := auth.uid();
  new.criado_em      := old.criado_em;      -- imutável
  new.criado_por     := old.criado_por;     -- imutável
  return new;
end $$;

drop trigger if exists registros_carimbo on public.registros;
create trigger registros_carimbo before update on public.registros
  for each row execute function public.tg_carimbo();

-- 7.2 o número só pode mudar quando sai de provisório para definitivo
create or replace function public.tg_numero_imutavel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.numero is distinct from old.numero and not old.provisorio then
    raise exception 'O número do registro não pode ser alterado.';
  end if;
  return new;
end $$;

drop trigger if exists registros_numero on public.registros;
create trigger registros_numero before update on public.registros
  for each row execute function public.tg_numero_imutavel();

-- 7.3 só gestor muda papel ou desativa alguém; ninguém se autopromove
create or replace function public.tg_perfil_protegido()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.atualizado_em := now();
  if not public.sou_gestor() then
    if new.papel     is distinct from old.papel     then raise exception 'Somente gestores alteram o papel.'; end if;
    if new.ativo     is distinct from old.ativo     then raise exception 'Somente gestores ativam ou desativam.'; end if;
    if new.matricula is distinct from old.matricula then raise exception 'A matrícula não pode ser alterada.'; end if;
  end if;
  return new;
end $$;

drop trigger if exists perfis_protegido on public.perfis;
create trigger perfis_protegido before update on public.perfis
  for each row execute function public.tg_perfil_protegido();

-- 7.4 impede que a empresa fique sem nenhum gestor ativo
create or replace function public.tg_ultimo_gestor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE' and old.papel = 'gestor' and old.ativo)
     or (tg_op = 'UPDATE' and old.papel = 'gestor' and old.ativo
         and (new.papel <> 'gestor' or not new.ativo)) then
    if (select count(*) from public.perfis where papel = 'gestor' and ativo and id <> old.id) = 0 then
      raise exception 'Precisa existir pelo menos um gestor ativo.';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists perfis_ultimo_gestor on public.perfis;
create trigger perfis_ultimo_gestor before update or delete on public.perfis
  for each row execute function public.tg_ultimo_gestor();


-- =====================================================================
-- 8. PERMISSÕES DE COLUNA
--    O Supabase concede tudo por padrão. Aqui derrubamos e devolvemos
--    coluna a coluna — é isto que impede a leitura de "documento".
-- =====================================================================
revoke all on public.perfis, public.registros, public.auditoria, public.contadores, public.fotos
  from anon, authenticated;

-- FOTOS
grant select (id, registro_id, momento, caminho, ordem, marcada, criado_em, criado_por)
  on public.fotos to authenticated;
grant insert (id, registro_id, momento, caminho, ordem, marcada)
  on public.fotos to authenticated;
grant delete on public.fotos to authenticated;

-- PERFIS
grant select (id, matricula, nome, papel, assinatura, ativo, criado_em, atualizado_em)
  on public.perfis to authenticated;
grant insert (id, matricula, nome, papel, assinatura, ativo)
  on public.perfis to authenticated;
grant update (nome, papel, assinatura, ativo, matricula)
  on public.perfis to authenticated;
grant delete on public.perfis to authenticated;

-- REGISTROS — note que "documento" aparece em INSERT e UPDATE, nunca em SELECT
grant select (id, numero, provisorio, status, pessoa, documento_mascarado, empresa, placa, veiculo,
              entrada, saida, setor, autorizador, porteiro_entrada, matricula_entrada, turno_entrada,
              porteiro_saida, matricula_saida, turno_saida, observacoes, confirm_entrada, confirm_saida,
              selo, criado_em, criado_por, atualizado_em, atualizado_por)
  on public.registros to authenticated;
grant insert (id, numero, provisorio, status, pessoa, documento, empresa, placa, veiculo,
              entrada, saida, setor, autorizador, porteiro_entrada, matricula_entrada, turno_entrada,
              porteiro_saida, matricula_saida, turno_saida, observacoes, confirm_entrada, confirm_saida, selo)
  on public.registros to authenticated;
grant update (numero, provisorio, status, pessoa, documento, empresa, placa, veiculo,
              entrada, saida, setor, autorizador, porteiro_saida, matricula_saida, turno_saida,
              observacoes, confirm_saida, selo)
  on public.registros to authenticated;
grant delete on public.registros to authenticated;

-- AUDITORIA — insere e lê; nunca altera nem apaga
grant select (id, registro_id, ts, evento, detalhe, autor, matricula, autor_id) on public.auditoria to authenticated;
grant insert (registro_id, evento, detalhe, autor, matricula) on public.auditoria to authenticated;

grant execute on function public.proximo_numero()          to authenticated;
grant execute on function public.revelar_documento(uuid)   to authenticated;
grant execute on function public.sou_ativo()               to authenticated;
grant execute on function public.sou_gestor()              to authenticated;


-- =====================================================================
-- 9. ROW LEVEL SECURITY
--    Sem sessão válida e perfil ativo, nada é lido nem gravado.
--    Nenhuma política menciona "anon": visitante anônimo não vê nada.
-- =====================================================================
alter table public.perfis     enable row level security;
alter table public.registros  enable row level security;
alter table public.auditoria  enable row level security;
alter table public.contadores enable row level security;

-- PERFIS
drop policy if exists perfis_ler        on public.perfis;
drop policy if exists perfis_criar      on public.perfis;
drop policy if exists perfis_alterar    on public.perfis;
drop policy if exists perfis_apagar     on public.perfis;

create policy perfis_ler on public.perfis for select to authenticated
  using (public.sou_ativo());

-- Cadastro de novo porteiro: só gestor. (Ver bloco PRIMEIRO GESTOR.)
create policy perfis_criar on public.perfis for insert to authenticated
  with check (public.sou_gestor());

-- Cada um edita o próprio cadastro (nome/assinatura); gestor edita qualquer um.
-- O que pode mudar em cada caso é controlado pelo gatilho tg_perfil_protegido.
create policy perfis_alterar on public.perfis for update to authenticated
  using (public.sou_gestor() or id = auth.uid())
  with check (public.sou_gestor() or id = auth.uid());

create policy perfis_apagar on public.perfis for delete to authenticated
  using (public.sou_gestor());

-- REGISTROS
drop policy if exists reg_ler     on public.registros;
drop policy if exists reg_criar   on public.registros;
drop policy if exists reg_alterar on public.registros;
drop policy if exists reg_apagar  on public.registros;

create policy reg_ler on public.registros for select to authenticated
  using (public.sou_ativo());

-- O porteiro só consegue criar registro em seu próprio nome.
create policy reg_criar on public.registros for insert to authenticated
  with check (public.sou_ativo() and matricula_entrada = public.minha_matricula());

create policy reg_alterar on public.registros for update to authenticated
  using (public.sou_ativo()) with check (public.sou_ativo());

-- Apagar registro é ação de gestor.
create policy reg_apagar on public.registros for delete to authenticated
  using (public.sou_gestor());

-- AUDITORIA
drop policy if exists aud_ler   on public.auditoria;
drop policy if exists aud_criar on public.auditoria;

create policy aud_ler on public.auditoria for select to authenticated
  using (public.sou_ativo());

create policy aud_criar on public.auditoria for insert to authenticated
  with check (public.sou_ativo());

-- FOTOS
drop policy if exists fot_ler   on public.fotos;
drop policy if exists fot_criar on public.fotos;
drop policy if exists fot_apagar on public.fotos;

create policy fot_ler on public.fotos for select to authenticated
  using (public.sou_ativo());

create policy fot_criar on public.fotos for insert to authenticated
  with check (public.sou_ativo());

-- Apagar foto é ação de gestor: a foto é evidência do que foi registrado.
create policy fot_apagar on public.fotos for delete to authenticated
  using (public.sou_gestor());

-- CONTADORES: ninguém toca direto; só a função proximo_numero() (security definer).
-- RLS ligada e nenhuma política = acesso negado a todos pela API.


-- =====================================================================
-- 9b. STORAGE — bucket das fotos
--     Privado: o arquivo só é acessível por quem tem sessão, e sempre
--     através de uma URL assinada de curta duração gerada na hora.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 5242880, array['image/jpeg','image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png'];

drop policy if exists fotos_obj_ler    on storage.objects;
drop policy if exists fotos_obj_criar  on storage.objects;
drop policy if exists fotos_obj_apagar on storage.objects;

create policy fotos_obj_ler on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and public.sou_ativo());

create policy fotos_obj_criar on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and public.sou_ativo());

create policy fotos_obj_apagar on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and public.sou_gestor());

-- Sem política de update: um arquivo enviado não é sobrescrito. Corrigir
-- uma marcação significa anexar outra foto, preservando a original.


-- =====================================================================
-- 9c. RONDA  — inspeção do porteiro pela unidade
-- ---------------------------------------------------------------------
-- Uma ronda é UM registro que dura do início ao fim da inspeção e pode
-- conter vários "packs de observação". O porteiro só registra o que está
-- fora do normal: ronda sem nenhuma observação é resultado válido.
--
-- Este bloco é acrescentado depois e altera a tabela "fotos", que passa a
-- servir aos dois módulos. Pode ser rodado em banco já em uso: tudo é
-- "if not exists" / "drop ... if exists".
-- =====================================================================
create table if not exists public.rondas (
  id             uuid primary key default gen_random_uuid(),
  numero         text not null unique,
  provisorio     boolean not null default false,  -- criada offline, numeração ainda não definitiva
  status         text not null default 'aberta' check (status in ('aberta','concluida')),

  inicio         timestamptz not null,
  fim            timestamptz,

  porteiro       text not null,
  matricula      text not null,
  turno          text,

  confirm        jsonb,        -- quem assinou o relatório: nome, matrícula, termo, assinatura
  selo           text,

  criado_em      timestamptz not null default now(),
  criado_por     uuid not null default auth.uid(),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid not null default auth.uid(),

  constraint fim_depois_do_inicio check (fim is null or fim >= inicio)
);

create index if not exists rondas_inicio_idx     on public.rondas (inicio desc);
create index if not exists rondas_status_idx     on public.rondas (status);
create index if not exists rondas_matricula_idx  on public.rondas (matricula);
create index if not exists rondas_atualizado_idx on public.rondas (atualizado_em desc);

comment on table public.rondas is
  'Uma ronda por inspeção. Fica aberta até o porteiro finalizar; as observações penduram nela.';

-- Pack de observação: o que o porteiro encontrou fora do normal.
create table if not exists public.observacoes (
  id          uuid primary key default gen_random_uuid(),
  ronda_id    uuid not null references public.rondas(id) on delete cascade,
  ordem       integer not null default 0,
  local       text not null check (char_length(btrim(local)) >= 2),
  descricao   text not null check (char_length(btrim(descricao)) >= 3),
  ts          timestamptz not null,          -- quando o porteiro registrou
  criado_em   timestamptz not null default now(),
  criado_por  uuid not null default auth.uid()
);

create index if not exists observacoes_ronda_idx on public.observacoes (ronda_id, ordem);

comment on table public.observacoes is
  'Pack de observação de uma ronda: onde, o quê, quando. As fotos ficam em public.fotos.';


-- ---------------------------------------------------------------------
-- A tabela "fotos" passa a atender entrada/saída DE VEÍCULO e observação
-- DE RONDA. Cada foto pertence a um só dos dois — nunca aos dois, nunca
-- a nenhum.
-- ---------------------------------------------------------------------
alter table public.fotos alter column registro_id drop not null;
alter table public.fotos add column if not exists observacao_id uuid
  references public.observacoes(id) on delete cascade;

create index if not exists fotos_observacao_idx on public.fotos (observacao_id, ordem);

alter table public.fotos drop constraint if exists fotos_momento_check;
alter table public.fotos add constraint fotos_momento_check
  check (momento in ('entrada','saida','observacao'));

alter table public.fotos drop constraint if exists foto_tem_um_dono;
alter table public.fotos add constraint foto_tem_um_dono check (
  (registro_id is not null and observacao_id is null) or
  (registro_id is null     and observacao_id is not null)
);

-- A trilha de auditoria passa a aceitar eventos de ronda.
alter table public.auditoria add column if not exists ronda_id uuid
  references public.rondas(id) on delete cascade;


-- ---------------------------------------------------------------------
-- Numeração das rondas — mesma ideia da numeração dos registros, contador
-- próprio para as duas séries não se misturarem.
-- ---------------------------------------------------------------------
create table if not exists public.contadores_ronda (
  ano    integer primary key,
  ultimo integer not null default 0
);

create or replace function public.proximo_numero_ronda()
returns text language plpgsql security definer set search_path = public as $$
declare
  v_ano integer := extract(year from now() at time zone 'America/Sao_Paulo');
  v_n   integer;
begin
  if not public.sou_ativo() then
    raise exception 'Usuário sem permissão.';
  end if;

  insert into public.contadores_ronda (ano, ultimo) values (v_ano, 1)
    on conflict (ano) do update set ultimo = public.contadores_ronda.ultimo + 1
    returning ultimo into v_n;

  return 'RND-' || v_ano || '-' || lpad(v_n::text, 4, '0');
end $$;

-- Os gatilhos genéricos servem: rondas tem as mesmas colunas de carimbo
-- e o mesmo par numero/provisorio dos registros.
drop trigger if exists rondas_carimbo on public.rondas;
create trigger rondas_carimbo before update on public.rondas
  for each row execute function public.tg_carimbo();

drop trigger if exists rondas_numero on public.rondas;
create trigger rondas_numero before update on public.rondas
  for each row execute function public.tg_numero_imutavel();


-- ---------------------------------------------------------------------
-- Permissões de coluna
-- ---------------------------------------------------------------------
revoke all on public.rondas, public.observacoes, public.contadores_ronda
  from anon, authenticated;

grant select (id, numero, provisorio, status, inicio, fim, porteiro, matricula, turno,
              confirm, selo, criado_em, criado_por, atualizado_em, atualizado_por)
  on public.rondas to authenticated;
grant insert (id, numero, provisorio, status, inicio, fim, porteiro, matricula, turno, confirm, selo)
  on public.rondas to authenticated;
-- Sem "inicio" e sem "matricula": quem abriu a ronda e quando não se altera depois.
grant update (numero, provisorio, status, fim, turno, confirm, selo)
  on public.rondas to authenticated;
grant delete on public.rondas to authenticated;

grant select (id, ronda_id, ordem, local, descricao, ts, criado_em, criado_por)
  on public.observacoes to authenticated;
grant insert (id, ronda_id, ordem, local, descricao, ts)
  on public.observacoes to authenticated;
-- Sem UPDATE: observação registrada é evidência. Corrigir = registrar outra.
grant delete on public.observacoes to authenticated;

grant select (observacao_id) on public.fotos to authenticated;
grant insert (observacao_id) on public.fotos to authenticated;
grant select (ronda_id) on public.auditoria to authenticated;
grant insert (ronda_id) on public.auditoria to authenticated;

grant execute on function public.proximo_numero_ronda() to authenticated;


-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.rondas           enable row level security;
alter table public.observacoes      enable row level security;
alter table public.contadores_ronda enable row level security;
-- contadores_ronda: RLS ligada e nenhuma política = só a função chega nela.

drop policy if exists ronda_ler     on public.rondas;
drop policy if exists ronda_criar   on public.rondas;
drop policy if exists ronda_alterar on public.rondas;
drop policy if exists ronda_apagar  on public.rondas;

create policy ronda_ler on public.rondas for select to authenticated
  using (public.sou_ativo());

-- O porteiro só abre ronda em seu próprio nome.
create policy ronda_criar on public.rondas for insert to authenticated
  with check (public.sou_ativo() and matricula = public.minha_matricula());

-- Quem abriu é quem finaliza. Gestor pode intervir.
create policy ronda_alterar on public.rondas for update to authenticated
  using      (public.sou_ativo() and (public.sou_gestor() or matricula = public.minha_matricula()))
  with check (public.sou_ativo() and (public.sou_gestor() or matricula = public.minha_matricula()));

create policy ronda_apagar on public.rondas for delete to authenticated
  using (public.sou_gestor());

drop policy if exists obs_ler    on public.observacoes;
drop policy if exists obs_criar  on public.observacoes;
drop policy if exists obs_apagar on public.observacoes;

create policy obs_ler on public.observacoes for select to authenticated
  using (public.sou_ativo());

-- Deliberadamente NÃO exige que a ronda ainda esteja aberta: uma ronda
-- feita sem internet sobe depois, e a fila pode entregar a finalização
-- antes de uma observação. Recusar aqui perderia o registro de campo.
-- O que aconteceu de fato fica em observacoes.ts (quando o porteiro
-- registrou) e criado_em (quando chegou ao servidor).
create policy obs_criar on public.observacoes for insert to authenticated
  with check (
    public.sou_ativo() and exists (
      select 1 from public.rondas r
       where r.id = ronda_id
         and (public.sou_gestor() or r.matricula = public.minha_matricula())
    )
  );

create policy obs_apagar on public.observacoes for delete to authenticated
  using (public.sou_gestor());


-- =====================================================================
-- 10. DESCARTE DE DADOS (LGPD)
--     Apaga o documento de visitantes de registros antigos, mantendo o
--     restante do histórico. Rode manualmente ou agende em
--     Database → Cron (extensão pg_cron).
--     Ajuste os 24 meses conforme a política de retenção da Perpec.
-- =====================================================================
create or replace function public.anonimizar_antigos(p_meses integer default 24)
returns integer language plpgsql security definer set search_path = public as $$
declare v_qtd integer;
begin
  if not public.sou_gestor() then
    raise exception 'Somente gestores podem executar o descarte.';
  end if;

  update public.registros
     set documento = null
   where documento is not null
     and entrada < now() - (p_meses || ' months')::interval;

  get diagnostics v_qtd = row_count;

  insert into public.auditoria (evento, detalhe, autor, matricula)
  values ('DESCARTE LGPD',
          v_qtd || ' registro(s) com mais de ' || p_meses || ' meses tiveram o documento apagado.',
          coalesce(public.meu_nome(), '—'), public.minha_matricula());

  return v_qtd;
end $$;

grant execute on function public.anonimizar_antigos(integer) to authenticated;


-- =====================================================================
-- PRIMEIRO GESTOR  — rode UMA vez, depois de criar o usuário
-- ---------------------------------------------------------------------
-- Passo 1: no painel do Supabase, vá em Authentication → Users →
--          "Add user" → "Create new user" e preencha:
--            Email:    1001@portaria.perpec.local
--            Password: (uma senha forte, entregue ao gestor)
--            Auto Confirm User: SIM
--          O trecho antes do @ é a MATRÍCULA. Use a matrícula real.
--
-- Passo 2: rode o comando abaixo trocando a matrícula e o nome.
--          Ele roda como dono do banco, então não passa pela RLS.
-- ---------------------------------------------------------------------
-- insert into public.perfis (id, matricula, nome, papel, ativo)
-- select id, '1001', 'Nome Completo do Gestor', 'gestor', true
--   from auth.users where email = '1001@portaria.perpec.local'
-- on conflict (id) do update set papel = 'gestor', ativo = true;
-- ---------------------------------------------------------------------
-- Depois disso, o gestor entra na aplicação com matrícula 1001 e a senha
-- definida, cadastra a própria assinatura e cria os demais porteiros
-- pela tela — sem precisar voltar ao painel do Supabase.
-- =====================================================================


-- =====================================================================
-- USAR O E-MAIL DA EMPRESA NO LUGAR DA MATRÍCULA
-- ---------------------------------------------------------------------
-- A tela de entrada aceita as duas coisas no mesmo campo. Para o gestor
-- passar a entrar com o e-mail corporativo:
--
-- CAMINHO 1 (sem SQL): cadastre-se como novo gestor pela própria tela,
--   em Porteiros → Cadastrar porteiro, escolhendo Perfil = Gestor e
--   informando o e-mail. Depois desative o cadastro antigo. Só não serve
--   se você quiser manter exatamente a mesma matrícula, que é única.
--
-- CAMINHO 2 (SQL): trocar o e-mail do usuário que já existe. O painel do
--   Supabase não expõe essa edição, mas o SQL Editor sim. O id do usuário
--   não muda, então perfil, matrícula, histórico e auditoria continuam
--   ligados a ele, e A SENHA CONTINUA A MESMA.
--
--   Edite as duas primeiras linhas e rode o bloco inteiro:
-- ---------------------------------------------------------------------
-- do $$
-- declare
--   v_antigo text := '1001@portaria.perpec.local';   -- e-mail atual
--   v_novo   text := 'joao@perpec.com.br';           -- e-mail novo
--   v_id     uuid;
-- begin
--   select id into v_id from auth.users where lower(email) = lower(v_antigo);
--   if v_id is null then
--     raise exception 'Não existe usuário com o e-mail %', v_antigo;
--   end if;
--   if exists (select 1 from auth.users where lower(email) = lower(v_novo)) then
--     raise exception 'Já existe usuário com o e-mail %', v_novo;
--   end if;
--
--   update auth.users
--      set email              = lower(v_novo),
--          email_confirmed_at = coalesce(email_confirmed_at, now()),
--          updated_at         = now()
--    where id = v_id;
--
--   -- A identidade do provedor "email" guarda o endereço em identity_data.
--   -- A coluna identities.email é gerada a partir dela, então segue sozinha.
--   update auth.identities
--      set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(lower(v_novo))),
--          updated_at    = now()
--    where user_id = v_id and provider = 'email';
--
--   raise notice 'Pronto: % agora entra como %', v_id, lower(v_novo);
-- end $$;
-- ---------------------------------------------------------------------
-- Confira depois com a consulta do bloco DIAGNÓSTICO.
--
-- A matrícula continua existindo e é ela que aparece nos registros e nos
-- PDFs — muda apenas o que se digita para entrar.
-- =====================================================================


-- =====================================================================
-- DIAGNÓSTICO  — rode quando o login não funcionar
-- ---------------------------------------------------------------------
-- Mostra, lado a lado, o usuário do Auth e o perfil da aplicação.
-- Leia assim:
--   "sem usuario no Auth"  -> o e-mail não existe. Confira se foi criado
--                             como MATRICULA@portaria.perpec.local, sem
--                             espaço e sem letra maiúscula.
--   confirmado = false     -> desligue "Confirm email" em Authentication →
--                             Providers → Email e confirme o usuário.
--   "sem perfil"           -> o usuário entra, mas a aplicação recusa.
--                             Rode o INSERT do bloco PRIMEIRO GESTOR.
--   papel <> 'gestor'      -> entra como porteiro. Corrija com o UPDATE
--                             que está logo abaixo.
-- ---------------------------------------------------------------------
-- select
--   u.email,
--   (u.email_confirmed_at is not null) as confirmado,
--   coalesce(p.matricula, '— sem perfil —') as matricula,
--   coalesce(p.nome,      '— sem perfil —') as nome,
--   coalesce(p.papel,     '— sem perfil —') as papel,
--   p.ativo,
--   (p.assinatura is not null) as tem_assinatura
-- from auth.users u
-- left join public.perfis p on p.id = u.id
-- order by u.created_at;
-- ---------------------------------------------------------------------
-- Promover alguém que já tem perfil a gestor:
--   update public.perfis set papel = 'gestor', ativo = true
--    where matricula = '1001';
--
-- Confirmar manualmente um usuário do Auth:
--   update auth.users set email_confirmed_at = now()
--    where email = '1001@portaria.perpec.local' and email_confirmed_at is null;
-- =====================================================================
