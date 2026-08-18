# Controle de Entrada de Veículos — Portaria

**FP-ADM-0002 RevForm.01** · Perpec Oilfield Supply

Aplicação de portaria para registrar a entrada e a saída de pessoas e veículos na unidade.
A tela é uma página estática (GitHub Pages) e os dados ficam num banco compartilhado
(Supabase): **o mesmo histórico aparece no PC da portaria, no celular e no tablet**.
O acesso exige matrícula e senha.

---

## Sumário

- [Arquivos](#arquivos)
- [Instalação](#instalação) ← **primeira vez, faça isto**
- [Como usar no dia a dia](#como-usar-no-dia-a-dia)
- [Código de cores](#código-de-cores)
- [Armazenamento](#armazenamento) ← **leia esta parte**
- [Segurança](#segurança)
- [Perfis e permissões](#perfis-e-permissões)
- [PDF de declaração](#pdf-de-declaração)
- [Configuração](#configuração)
- [Limitações conhecidas](#limitações-conhecidas)

---

## Arquivos

| Arquivo | O que é | Obrigatório |
|---|---|---|
| `index.html` | A aplicação: tela e lógica | Sim |
| `sync.js` | Login, fila de envio e conversa com o servidor | Sim |
| `config.js` | Endereço e chave pública do projeto Supabase | Sim |
| `logo.js` | Logo da Perpec em base64, usada nos PDFs | Sim |
| `supabase-schema.sql` | Estrutura do banco. Roda uma vez, na instalação | Só na instalação |
| `PERPEC - LOGO PRINCIPAL.png` | Logo original, exibida no cabeçalho | Recomendado |
| `README.md` | Este documento | Não |

> **Por que a logo é um `.js` e não só o PNG?**
> Quando a página é aberta direto do disco (`file://`), o navegador proíbe ler uma imagem
> local por dentro do código. O `logo.js` contorna isso trazendo a imagem já convertida em
> texto. Para trocar a logo: substitua o PNG e gere o `logo.js` de novo a partir dele.

### Internet

A aplicação **precisa de internet** para sincronizar. Sem conexão ela continua registrando
entradas e saídas normalmente, guardando tudo numa fila local que sobe sozinha quando a
rede volta — veja [Trabalhando sem internet](#trabalhando-sem-internet).

---

## Instalação

Feita uma única vez, por quem administra o sistema.

**1. Criar o projeto no Supabase**
Em [supabase.com](https://supabase.com), crie um projeto. Escolha a região
**South America (São Paulo)** — mantém os dados pessoais no Brasil, o que simplifica a LGPD.

**2. Criar as tabelas e as regras**
No painel: `SQL Editor` → `New query` → cole o conteúdo de `supabase-schema.sql` → `Run`.

**3. Desligar a confirmação de e-mail**
Em `Authentication` → `Providers` → `Email`, desligue **Confirm email**. O login é por
matrícula; os e-mails internos (`1042@portaria.perpec.local`) não existem de verdade e
nenhuma mensagem é enviada. Mantenha **Allow new users to sign up** ligado — é por ele que
o gestor cria os porteiros pela tela.

**4. Preencher o `config.js`**

- `SUPABASE_URL` — em `Project Settings` → `Data API` → **Project URL**.
  Use **só o endereço**, sem caminho no fim:
  `https://abcdefgh.supabase.co` ✅ · `https://abcdefgh.supabase.co/rest/v1/` ❌
  O `/rest/v1/` é acrescentado sozinho pela biblioteca; deixá-lo aqui duplica o caminho e
  todas as chamadas falham.
- `SUPABASE_ANON_KEY` — em `Project Settings` → `API Keys` → chave **anon / public**.
  É um texto longo, começando com `eyJ` (ou `sb_publishable_`).

Nunca use a chave `service_role`. Se algum dos dois estiver faltando ou errado, a tela de
entrada diz exatamente qual é o problema.

**5. Criar o primeiro gestor**
Siga o bloco **PRIMEIRO GESTOR**, no fim do `supabase-schema.sql`: criar o usuário em
`Authentication` → `Users` → `Add user` (com *Auto Confirm User* ligado) e rodar o `INSERT`
indicado. A partir daí o gestor entra pela tela e cadastra os demais porteiros sozinho.

**6. Publicar**
Suba os arquivos para o repositório do GitHub Pages. A página pode ser pública: sem login
com matrícula e senha, ela não mostra nem grava nada.

---

## Como usar no dia a dia

### 1. Cadastro de porteiros — feito uma vez só (gestor)

Aba **Porteiros** → *Cadastrar porteiro*. Informe:

- **Matrícula** (só números, não pode repetir) — é o login da pessoa
- **Nome completo**
- **Senha** de acesso, com no mínimo 8 caracteres, entregue à pessoa
- **Perfil**: porteiro ou gestor
- **Assinatura**, desenhada com o dedo (tela sensível ao toque) ou com o mouse

O cadastro vale para todos os aparelhos. Cada um pode trocar a própria senha depois, em
**Minha conta**. Quem já aparece em algum registro não pode ser apagado — use
**Desativar**, que corta o acesso sem quebrar o histórico.

### 2. Entrar no sistema

Ao abrir a página, a tela pede **matrícula e senha**. A sessão fica guardada no aparelho,
então no uso normal isso é feito uma vez por turno — ou uma vez só, no computador fixo da
portaria.

Use **Sair** ao terminar, principalmente em celular ou aparelho compartilhado: ao sair, a
cópia local de dados é apagada do aparelho.

### 3. Começar o turno

Na faixa do topo, *Começar turno*. O porteiro é o próprio usuário logado — só falta
escolher a escala, que já vem marcada conforme o horário.

Enquanto não houver turno aberto, o formulário de entrada fica travado.

### 4. Registrar uma entrada

Aba **Nova entrada**, cinco passos numerados:

1. Quem está entrando (nome, empresa, documento)
2. Carro (placa e, opcionalmente, modelo/cor)
3. Hora que entrou (botão *Usar a hora de agora*)
4. Quem autorizou (setor + nome da pessoa)
5. Anotações livres e confirmação

A confirmação é um botão grande que fica verde. O porteiro **não redigita nada** —
nome, matrícula e assinatura vêm do turno aberto.

### 5. Registrar a saída

Aba **Estão dentro** → botão *Registrar saída* no cartão do veículo. Informe a hora,
anotações opcionais e confirme. O registro passa para **Já saíram**.

---

## Código de cores

Uma cor tem sempre o mesmo significado — na tela, na tabela e nos contadores:

| Cor | Situação |
|---|---|
| 🔵 **Azul** | Está dentro, dentro do tempo normal |
| 🟡 **Amarelo** | Dentro há mais de **12 h** — verificar |
| 🔴 **Vermelho** | Dentro há mais de **24 h** — resolver |
| 🟢 **Verde** | Já saiu / registro concluído |

Os limites de 12 h e 24 h são configuráveis (ver [Configuração](#configuração)).
A legenda fica visível na aba *Estão dentro*, junto de quatro contadores clicáveis que
filtram a lista por cor.

---

## Armazenamento

### Onde os dados ficam

Existem **dois lugares**, com papéis bem diferentes:

| Lugar | O que guarda | Papel |
|---|---|---|
| **Supabase** (servidor) | Registros, cadastro de porteiros, trilha de auditoria, numeração | **Fonte da verdade.** É o dado que vale. |
| **`localStorage`** do aparelho | Uma cópia do que veio do servidor + a fila de envio | Cache. Serve para a tela abrir na hora e para funcionar sem internet. |

Consequência prática: **o histórico é o mesmo em qualquer aparelho**. O que se registra no
PC aparece no celular, e vice-versa. Limpar o navegador, trocar de computador ou usar
janela anônima não perde nada — na próxima entrada com matrícula e senha tudo volta.

### Tabelas no servidor

| Tabela | Conteúdo |
|---|---|
| `perfis` | Porteiros e gestores: matrícula, nome, perfil, assinatura, ativo |
| `registros` | Entradas e saídas |
| `auditoria` | Histórico de eventos. Só cresce: a API não tem permissão de alterar nem apagar |
| `contadores` | Numeração sequencial por ano. Nenhum usuário acessa direto |

Cada registro é uma linha com colunas próprias (`pessoa`, `placa`, `entrada`, `saida`,
`setor`, `autorizador`, `matricula_entrada`, …), não um bloco de texto. Datas são gravadas
em UTC (`timestamptz`) e exibidas no fuso do aparelho.

### Numeração

O número (`PORT-2026-0042`) é gerado **pelo servidor**, pela função `proximo_numero()`, que
incrementa um contador dentro da mesma transação. Dois aparelhos registrando ao mesmo tempo
nunca recebem o mesmo número — problema que não teria solução se a numeração fosse feita em
cada aparelho.

### Trabalhando sem internet

A portaria não pode parar quando a rede cai. Quando isso acontece:

1. A entrada é registrada normalmente e recebe um **número provisório** (`PORT-2026-P001`).
   A tela avisa antes de confirmar.
2. O cartão do registro ganha a etiqueta amarela **AGUARDANDO ENVIO**, e a barra do topo
   mostra quantos estão na fila.
3. Quando a internet volta, a fila sobe sozinha, em ordem. Cada registro provisório recebe
   então o **número definitivo** do servidor.

Enquanto estiver provisório, o registro não permite gerar PDF sem um aviso — o número
impresso mudaria depois. Saídas e correções feitas offline também entram na fila e são
aplicadas na ordem certa.

A fila fica no `localStorage`, na chave `perpec.portaria.outbox`. O navegador avisa antes
de fechar a página se ainda houver algo nela.

### Como a tela se mantém atualizada

- **A cada 30 s**: busca só o que mudou desde a última vez (rápido, pouco tráfego).
- **A cada 5 min**: busca tudo (é o que detecta registros apagados por um gestor).
- **Ao voltar a conexão** ou **ao voltar para a aba**: busca imediatamente.
- **Botão *Atualizar agora***, na aba Histórico, força a sincronização.

### O documento do visitante (RG/CPF)

Este é o dado mais sensível e recebe tratamento próprio:

- A coluna `documento` **não tem permissão de leitura** pela API. Não existe consulta que
  a traga — nem alterando o código da página, porque a restrição é do banco.
- A tela recebe apenas `documento_mascarado`, calculado pelo próprio banco: `•••••••89-10`.
- Só o **gestor** vê o valor completo, um registro por vez, pelo botão *Ver completo*.
  Essa consulta passa pela função `revelar_documento()`, que **grava na auditoria** quem
  consultou, de quem e quando.
- A cópia local **nunca guarda o documento em texto claro**. Ele existe na memória apenas
  entre o preenchimento e o envio; depois disso, só a máscara.
- No formulário de correção o campo aparece vazio, com a máscara no *placeholder*: quem
  edita não vê o valor antigo e só o substitui se digitar um novo.

### Descarte (LGPD)

Na aba **Histórico**, o gestor tem *Descartar documentos antigos*: apaga o campo
`documento` de registros mais velhos que N meses (padrão sugerido: 24), preservando o resto
do histórico. A operação é registrada na auditoria. Também pode ser agendada no servidor
com `pg_cron`, chamando `anonimizar_antigos(24)`.

### Exportação

*Exportar para Excel*, na aba Histórico, gera um CSV do que estiver filtrado na tela —
separador `;` e BOM UTF-8, abre direto no Excel em português. O documento sai **mascarado**
também no CSV.

Não há mais backup manual: o servidor é responsável pela persistência. O Supabase mantém
backups automáticos do banco (verifique a política do seu plano) e, se quiser uma cópia
fria periódica, use `Database` → `Backups` no painel ou um `pg_dump` agendado.

---

## Segurança

O ponto de partida é que **a página é pública**: qualquer pessoa com o endereço abre o
`index.html` e lê todo o JavaScript, inclusive a chave `anon` do `config.js`. Por isso a
proteção não está — e não pode estar — na tela. Ela está no banco.

### O que protege de verdade

| Camada | Como funciona |
|---|---|
| **Autenticação** | Nada é lido nem gravado sem sessão válida. Login por matrícula + senha, gerido pelo Supabase Auth. A senha nunca passa pela aplicação em texto guardado. |
| **Row Level Security** | Toda tabela tem RLS ligada. Nenhuma política atende usuário anônimo — a chave pública sozinha não lê uma linha sequer. |
| **Permissão por coluna** | O `GRANT` de leitura é dado coluna a coluna. `documento` simplesmente não está na lista. |
| **Verificação por perfil** | Apagar registro, ver documento completo, cadastrar porteiro e executar o descarte exigem perfil de gestor, **checado no servidor**. |
| **Autoria no servidor** | `criado_por` e `atualizado_por` são preenchidos por gatilho com a identidade da sessão. Não dá para forjar pelo navegador. |
| **Auditoria imutável** | A tabela `auditoria` não tem permissão de `UPDATE` nem `DELETE`. Ninguém apaga um evento pela aplicação. |
| **Invariantes por gatilho** | O número do registro não muda depois de definitivo; ninguém se autopromove a gestor; a empresa não fica sem nenhum gestor ativo. |
| **Transporte** | HTTPS de ponta a ponta (GitHub Pages e Supabase). |

> A chave `anon` **pode** ficar no GitHub. A chave `service_role` **nunca** — ela ignora
> toda a RLS. Se ela vazar, o banco inteiro vaza junto.

### Controles que continuam da versão anterior

Numeração automática, trilha de auditoria por registro, registro concluído travado
(reabertura exige justificativa), validação de placa Mercosul e antiga, coerência de
horários, alerta de placa já dentro da unidade, exclusão com dupla confirmação e escape de
todo texto digitado antes de ir para a tela.

O **selo de integridade** continua sendo calculado e impresso no PDF, mas deixou de ser o
controle principal: agora quem garante que um registro não foi adulterado é o banco, com
autoria e auditoria do lado do servidor.

### Higiene em aparelho compartilhado

O botão **Sair** apaga a cópia local do aparelho, além de encerrar a sessão. Em celular ou
tablet compartilhado, use sempre — sem isso a última cópia de registros fica legível para
quem pegar o aparelho depois.

---

## Perfis e permissões

| Ação | Porteiro | Gestor |
|---|---|---|
| Registrar entrada e saída | Sim | Sim |
| Consultar histórico e exportar CSV | Sim | Sim |
| Corrigir registro aberto / reabrir concluído | Sim | Sim |
| Gerar PDF de declaração | Sim | Sim |
| Editar o próprio cadastro e trocar a própria senha | Sim | Sim |
| **Ver o documento completo do visitante** | Não | Sim (auditado) |
| **Apagar registro** | Não | Sim |
| **Cadastrar, desativar ou apagar porteiros** | Não | Sim |
| **Executar o descarte de documentos antigos** | Não | Sim |

Um porteiro só consegue criar registro **em seu próprio nome**: a regra do banco compara
`matricula_entrada` com a matrícula da sessão.

---

## PDF de declaração

Botão **Gerar PDF** em qualquer registro (aberto ou concluído). Produz a
*Declaração de Autorização de Entrada*, em A4, contendo:

- Logo da Perpec, título, número do registro e data de emissão
- Quem entrou e com qual veículo
- Entrada, saída e tempo de permanência
- Setor e pessoa que autorizaram, porteiros de entrada e de saída com matrícula
- Anotações da portaria, quando houver
- Termos de conferência com a **assinatura desenhada** do porteiro sobre a linha
- Selo de integridade no rodapé

O arquivo é salvo como `Declaracao-Entrada-PORT-ANO-0000.pdf` na pasta de downloads.
A emissão fica registrada na trilha de auditoria do registro.

---

## Configuração

Tudo o que muda com frequência está no bloco `CONFIG`, no topo do `index.html`
(por volta da linha 19). Não é preciso mexer no resto do código.

| Parâmetro | Para que serve |
|---|---|
| `DOC_REF` | Código do documento no cabeçalho da tela e no rodapé do PDF |
| `PREFIXO_REGISTRO` | Prefixo da numeração (`PORT`) |
| `DB_KEY` | Chave do armazenamento. **Mudar equivale a começar uma base nova** |
| `ALERTA_PERMANENCIA_H` | Horas para o cartão ficar amarelo (12) |
| `CRITICO_PERMANENCIA_H` | Horas para o cartão ficar vermelho (24) |
| `TOLERANCIA_FUTURO_MIN` | Minutos aceitos "no futuro", para desvio de relógio (5) |
| `CONFIRMA_RETROATIVO_H` | Horas de atraso a partir das quais pede confirmação (24) |
| `TURNOS` | Escala. Hoje 12x12: Diurno 07h–19h e Noturno 19h–07h |
| `SETORES` | Lista de setores que podem autorizar entradas |
| `TERMO_ENTRADA` / `TERMO_SAIDA` | Texto dos termos confirmados pelo porteiro |

---

## Limitações conhecidas

- **Um computador, uma base.** Não há sincronização automática entre máquinas. Duas
  portarias funcionando ao mesmo tempo precisam de bases separadas, consolidadas depois
  por restauração de backup.
- **Sem controle de acesso.** Quem senta na máquina usa o sistema. A identificação por
  matrícula registra *quem declarou* ser o porteiro, mas não autentica (não há senha).
  O controle é físico e disciplinar.
- **PDF exige internet** na primeira geração da sessão, para carregar as bibliotecas do CDN.
- **Limite de ~5 MB** do `localStorage`. Suficiente para alguns milhares de registros;
  acompanhe o indicador de espaço na aba Histórico.
- **Dados pessoais (LGPD).** A aplicação armazena nome, documento e placa de visitantes.
  Trate a máquina da portaria e os arquivos de backup como material controlado, e defina
  um prazo de descarte para os registros antigos.

---

*Perpec Oilfield Supply — Engenharia*
