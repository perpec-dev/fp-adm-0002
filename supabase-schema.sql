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

comment on table  public.perfis is 'Porteiros e gestores. A matrícula é o login.';
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
revoke all on public.perfis, public.registros, public.auditoria, public.contadores
  from anon, authenticated;

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

-- CONTADORES: ninguém toca direto; só a função proximo_numero() (security definer).
-- RLS ligada e nenhuma política = acesso negado a todos pela API.


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
