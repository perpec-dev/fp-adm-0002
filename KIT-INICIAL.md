# Kit inicial — Formulários web Perpec

**Padrão de arquitetura, layout e segurança** extraído do FP-ADM-0002 (Controle de Entrada
de Veículos). Serve como ponto de partida para qualquer formulário novo da Engenharia.

---

## Como usar este documento

Ele é escrito para funcionar como **prompt**. Para começar um projeto novo:

> Cole este arquivo inteiro no chat, e em seguida escreva o que o formulário precisa fazer:
> campos, regras de negócio, quem usa, o que vira PDF, o que vira relatório.
> A resposta deve seguir este padrão sem inventar outro.

Se o formulário for simples e **sem dados compartilhados entre aparelhos**, diga isso
explicitamente — aí a camada de Supabase é dispensada e o `localStorage` vira o
armazenamento definitivo (ver [Perfil A](#dois-perfis-de-projeto)).

---

## Sumário

- [Dois perfis de projeto](#dois-perfis-de-projeto)
- [Arquivos do projeto](#arquivos-do-projeto)
- [Design system (CSS)](#design-system-css)
- [Esqueleto HTML](#esqueleto-html)
- [Convenções de JavaScript](#convenções-de-javascript)
- [Camada de dados (Supabase)](#camada-de-dados-supabase)
- [Esquema SQL modelo](#esquema-sql-modelo)
- [Geração de PDF (jsPDF)](#geração-de-pdf-jspdf)
- [Regras de UX](#regras-de-ux)
- [Checklist antes de publicar](#checklist-antes-de-publicar)

---

## Dois perfis de projeto

Decida isto **antes de escrever a primeira linha**, porque muda a arquitetura inteira.

| | **Perfil A — local** | **Perfil B — compartilhado** |
|---|---|---|
| Quando usar | Formulário preenchido e enviado na hora; nada precisa ser consultado depois em outro aparelho | Há histórico, consulta posterior, mais de um usuário ou mais de um aparelho |
| Armazenamento | `localStorage` (definitivo) | Supabase (fonte da verdade) + `localStorage` (cache) |
| Login | Nenhum | Obrigatório, com papéis |
| Arquivos | `index.html`, `logo.js` | `+ config.js`, `sync.js`, `supabase-schema.sql` |
| Backup | Exportação manual em JSON, obrigatória | Responsabilidade do servidor |

> **Não comece pelo Perfil A "para depois migrar".** A migração custa mais do que já nascer
> no Perfil B. Se houver qualquer chance de consulta em outro aparelho, comece no B.

---

## Arquivos do projeto

```
FP-XXX-0000 Nome do formulário/
├── index.html              A aplicação: tela + lógica
├── config.js               URL e chave pública do Supabase   (Perfil B)
├── sync.js                 Login, fila offline, acesso ao banco (Perfil B)
├── logo.js                 Logo em base64 para o PDF
├── supabase-schema.sql     Esquema, RLS, gatilhos            (Perfil B)
├── PERPEC - LOGO PRINCIPAL.png
└── README.md               Documentação para quem opera e para quem mantém
```

Ordem dos `<script>` no `<head>` (importa):

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js"></script>
<script src="logo.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script src="config.js"></script>
<script src="sync.js"></script>
```

### Gerar o `logo.js`

O navegador bloqueia ler uma imagem local por canvas quando a página abre por `file://`, e
sem isso o PDF sai sem logo. A solução é embutir a imagem já convertida:

```powershell
$bytes = [System.IO.File]::ReadAllBytes("PERPEC - LOGO PRINCIPAL.png")
$b64   = [System.Convert]::ToBase64String($bytes)
$txt   = 'window.LOGO_B64 = "data:image/png;base64,' + $b64 + '";'
[System.IO.File]::WriteAllText("logo.js", $txt, (New-Object System.Text.UTF8Encoding($false)))
```

---

## Design system (CSS)

Copie o bloco inteiro. **Não invente cores fora dos tokens** — o padrão visual da Perpec
depende disso.

### Tokens

```css
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --red:#C0392B;--red2:#961c13;--dark:#1A1210;
  --bg:#F2F1ED;--surface:#FFFFFF;--surface2:#F8F7F5;
  --border:#E0DBD5;--border2:#C5BDB5;
  --text:#18171A;--muted:#6A6760;
  --accent:#C0392B;--accent-lt:#FDF0EF;
  --radius:8px;--radius-lg:12px;
  --green:#2E7D32;--green-bg:#EAF6EB;--green-bd:#A7D7AA;
  --yellow:#B7791F;--yellow-bg:#FEF7E6;--yellow-bd:#F0D98A;
  --blue:#3D5AC0;--blue-bg:#EEF2FF;--blue-bd:#B9C5EC;

  /* SEMÁFORO — uma cor = um significado, em TODA a aplicação e nos PDFs.
     Renomeie os papéis conforme o domínio, mas mantenha um significado
     único por cor e declare-o num comentário como este.               */
  --st-in:#3D5AC0;   --st-in-bg:#EEF2FF;   --st-in-bd:#B9C5EC;  /* em andamento  */
  --st-warn:#B7791F; --st-warn-bg:#FEF7E6; --st-warn-bd:#F0D98A;/* atenção       */
  --st-late:#C0392B; --st-late-bg:#FDECEA; --st-late-bd:#E8B8B0;/* crítico       */
  --st-out:#2E7D32;  --st-out-bg:#EAF6EB;  --st-out-bd:#A7D7AA; /* concluído     */
}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);
     min-height:100vh;-webkit-font-smoothing:antialiased}
```

### Cabeçalho e faixa do documento

```css
.site-header{background:#fff;border-bottom:3px solid var(--red);box-shadow:0 2px 8px rgba(0,0,0,.08)}
.header-inner{max-width:1080px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;
              gap:12px;padding:.7rem 1.5rem}
.header-logo img{height:44px;width:auto;display:block}
.header-right{text-align:right;margin-left:auto}
.header-right .title{font-size:15px;font-weight:700;color:var(--dark)}
.header-right .sub{font-size:11px;color:var(--muted);margin-top:2px}

.doc-strip{background:var(--dark);padding:.55rem 1.5rem}
.doc-strip-inner{max-width:1080px;margin:0 auto;display:flex;align-items:center;
                 justify-content:space-between;flex-wrap:wrap;gap:.4rem}
.doc-code-label{font-size:11px;color:#A09090;letter-spacing:.05em;text-transform:uppercase;margin-right:4px}
.doc-code-val{font-family:"Courier New",monospace;font-size:14px;font-weight:700;color:#fff;letter-spacing:.1em}
.doc-meta{font-size:12px;color:#D8CCCC;font-family:"Courier New",monospace;font-weight:700}

.sticky-top{position:sticky;top:0;z-index:100}
.wrap{max-width:1080px;margin:0 auto;padding:1.5rem 1rem 5rem}
```

### Cartões e grade

```css
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);
      margin-bottom:1.1rem;box-shadow:0 1px 3px rgba(0,0,0,.05);position:relative}
.card-head{background:var(--dark);padding:.75rem 1.3rem;display:flex;align-items:center;gap:10px;
           border-radius:var(--radius-lg) var(--radius-lg) 0 0}
.card-head h2{font-size:13px;font-weight:700;letter-spacing:.04em;color:#F0E6E4}
.card-head svg{width:15px;height:15px;stroke:#E08070;fill:none;stroke-width:2.2;
               stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
/* Numeral do passo: orienta a ordem sem depender de leitura */
.step{width:26px;height:26px;border-radius:50%;background:var(--red);color:#fff;font-size:14px;
      font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.card-body{padding:1.25rem 1.3rem}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.full{grid-column:1/-1}
@media(max-width:700px){.g2{grid-template-columns:1fr}.full{grid-column:1}}
```

### Campos

Fonte 16px é obrigatória: abaixo disso o iOS dá zoom sozinho ao focar o campo.

```css
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:13px;font-weight:700;color:var(--text);letter-spacing:.01em}
.req{color:var(--red);margin-left:2px}
.field input,.field textarea,.field select{
  border:1.5px solid var(--border2);border-radius:var(--radius);padding:12px 13px;font-size:16px;
  font-family:inherit;color:var(--text);background:var(--surface);width:100%;
  transition:border-color .14s,box-shadow .14s}
.field input:focus,.field textarea:focus,.field select:focus{
  outline:none;border-color:var(--red);box-shadow:0 0 0 3px rgba(192,57,43,.14)}
.field input[readonly]{background:var(--surface2);color:var(--muted);cursor:default;border-style:dashed}
.field textarea{resize:vertical;min-height:84px}
.field .hint{font-size:12px;color:var(--muted)}
.field.err input,.field.err select,.field.err textarea{border-color:var(--red);background:var(--accent-lt)}
.field .msg{display:none;font-size:12.5px;font-weight:700;color:var(--red)}
.field.err .msg{display:block}
```

Campo de código (placa, matrícula, número de série) usa monoespaçada grande e centralizada:

```html
<input style="font-family:'Courier New',monospace;font-size:19px;font-weight:700;
              letter-spacing:.14em;text-align:center">
```

### Botões

```css
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:12px 18px;
     min-height:46px;border:none;border-radius:var(--radius);font-size:14.5px;font-weight:700;
     cursor:pointer;transition:all .13s;font-family:inherit;white-space:nowrap}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.15)}
.btn:active{transform:translateY(0)}
.btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2.4;
         stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.btn-dark{background:var(--dark);color:#fff}      .btn-dark:hover{background:#2D1F1A}
.btn-red{background:var(--red);color:#fff}        .btn-red:hover{background:var(--red2)}
.btn-green{background:var(--st-out);color:#fff}   .btn-green:hover{background:#25682a}
.btn-outline{background:var(--surface);color:var(--text);border:1.5px solid var(--border2)}
.btn-outline:hover{background:var(--surface2);border-color:#9A9087}
.btn-sm{padding:8px 13px;min-height:38px;font-size:13px}
.btn-xl{padding:16px 24px;min-height:58px;font-size:16.5px;width:100%}
.btn:disabled{background:var(--border2)!important;cursor:not-allowed;color:var(--muted);
              transform:none!important;box-shadow:none!important}

.act-bar{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);
         padding:1.1rem 1.3rem;display:flex;align-items:center;justify-content:space-between;
         flex-wrap:wrap;gap:12px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.act-group{display:flex;gap:9px;flex-wrap:wrap}
@media(max-width:768px){.act-bar{flex-direction:column;align-items:stretch}
                        .act-group{justify-content:stretch}.act-bar .btn{width:100%}}
```

Regra: **uma tela, uma ação primária.** Ela usa `.btn-red.btn-xl` com verbo em caixa alta
(`LIBERAR ENTRADA`, `ENVIAR AVALIAÇÃO`). Todas as outras são `.btn-outline`.

### Abas

```css
.tabs{background:var(--surface);border-bottom:1px solid var(--border);
      box-shadow:0 2px 6px rgba(0,0,0,.05);overflow-x:auto}
.tabs-inner{max-width:1080px;margin:0 auto;display:flex;gap:2px;padding:0 1.2rem}
.tab{border:none;background:none;font-family:inherit;font-size:14px;font-weight:700;color:var(--muted);
     padding:14px 16px;cursor:pointer;border-bottom:4px solid transparent;white-space:nowrap;
     display:flex;align-items:center;gap:8px;transition:color .13s,border-color .13s}
.tab:hover{color:var(--text)}
.tab.sel{color:var(--red);border-bottom-color:var(--red)}
.tab .n{font-size:12px;font-weight:800;border-radius:20px;padding:2px 9px;min-width:24px;text-align:center;
        background:var(--st-in-bg);border:1px solid var(--st-in-bd);color:var(--st-in)}
.tab .n.zero{background:var(--surface2);border-color:var(--border);color:var(--muted)}
.tab .n.warn{background:var(--st-warn-bg);border-color:var(--st-warn-bd);color:var(--st-warn)}
.tab .n.late{background:var(--st-late-bg);border-color:var(--st-late-bd);color:var(--st-late)}
.tab .n.out {background:var(--st-out-bg); border-color:var(--st-out-bd); color:var(--st-out)}
.pane{display:none}
.pane.on{display:block}
```

### Sinalização de estado

```css
.bdg{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;
     border-radius:20px;white-space:nowrap;border:1.5px solid transparent}
.bdg.b-in  {background:var(--st-in-bg);  color:var(--st-in);  border-color:var(--st-in-bd)}
.bdg.b-warn{background:var(--st-warn-bg);color:var(--st-warn);border-color:var(--st-warn-bd)}
.bdg.b-late{background:var(--st-late-bg);color:var(--st-late);border-color:var(--st-late-bd)}
.bdg.b-out {background:var(--st-out-bg); color:var(--st-out); border-color:var(--st-out-bd)}

.warn-box{font-size:13.5px;font-weight:600;border-radius:var(--radius);padding:12px 14px;
          margin-bottom:13px;border:1.5px solid;line-height:1.5}
.warn-box.i{color:var(--st-in);  background:var(--st-in-bg);  border-color:var(--st-in-bd)}
.warn-box.w{color:var(--st-warn);background:var(--st-warn-bg);border-color:var(--st-warn-bd)}
.warn-box.e{color:var(--st-late);background:var(--st-late-bg);border-color:var(--st-late-bd)}
.warn-box.g{color:var(--st-out); background:var(--st-out-bg); border-color:var(--st-out-bd)}

.empty-state{text-align:center;padding:2.6rem 1rem;color:var(--muted);font-size:14px;
             border:2px dashed var(--border2);border-radius:var(--radius-lg);background:var(--surface)}
```

### Cartão de item de lista

Faixa colorida no topo: a situação é lida pela cor antes do texto.

```css
.rec{border:1px solid var(--border);border-left:7px solid var(--border2);border-radius:var(--radius);
     background:var(--surface);margin-bottom:12px;cursor:pointer;overflow:hidden;
     transition:box-shadow .13s,border-color .13s}
.rec:hover{box-shadow:0 4px 16px rgba(0,0,0,.1)}
.rec.s-in{border-left-color:var(--st-in)}     .rec.s-warn{border-left-color:var(--st-warn)}
.rec.s-late{border-left-color:var(--st-late)} .rec.s-out{border-left-color:var(--st-out)}
.rec-status{display:flex;align-items:center;gap:9px;padding:8px 14px;font-size:12.5px;font-weight:800;
            letter-spacing:.03em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.rec.s-in   .rec-status{background:var(--st-in-bg);  color:var(--st-in)}
.rec.s-warn .rec-status{background:var(--st-warn-bg);color:var(--st-warn)}
.rec.s-late .rec-status{background:var(--st-late-bg);color:var(--st-late)}
.rec.s-out  .rec-status{background:var(--st-out-bg); color:var(--st-out)}
.rec-status .dot{width:11px;height:11px;border-radius:50%;background:currentColor;flex-shrink:0}
.rec-in{padding:13px 14px}
.rec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:9px 16px;font-size:13px}
.rec-grid .k{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.rec-grid .v{color:var(--text);font-weight:600;margin-top:2px;word-break:break-word}
.rec-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:11px;border-top:1px dashed var(--border)}
```

### Tabela

```css
.tbl-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
table.tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:920px}
table.tbl th{background:var(--surface2);color:var(--muted);font-size:10.5px;font-weight:800;
             letter-spacing:.07em;text-transform:uppercase;text-align:left;padding:10px;
             border-bottom:1px solid var(--border)}
table.tbl td{padding:10px;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text)}
table.tbl tbody tr{cursor:pointer;transition:background .1s}
table.tbl tbody tr:hover{background:var(--surface2)}
table.tbl tbody tr.l-in   td:first-child{box-shadow:inset 5px 0 0 var(--st-in)}
table.tbl tbody tr.l-warn td:first-child{box-shadow:inset 5px 0 0 var(--st-warn)}
table.tbl tbody tr.l-late td:first-child{box-shadow:inset 5px 0 0 var(--st-late)}
table.tbl tbody tr.l-out  td:first-child{box-shadow:inset 5px 0 0 var(--st-out)}
table.tbl td.mono{font-family:"Courier New",monospace;font-weight:700;letter-spacing:.06em}
```

### Modal e aviso flutuante

```css
.modal{position:fixed;inset:0;z-index:9000;background:rgba(26,18,16,.72);backdrop-filter:blur(3px);
       display:flex;align-items:flex-start;justify-content:center;padding:1.2rem;overflow-y:auto}
.modal[hidden]{display:none}
.modal-card{background:var(--surface);border-radius:var(--radius-lg);max-width:760px;width:100%;
            box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden;margin:auto}
.modal-head{background:var(--dark);padding:1rem 1.3rem;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.modal-head h3{font-size:15px;font-weight:700;color:#F0E6E4}
.modal-head .x{margin-left:auto;background:none;border:none;color:#A09090;font-size:26px;line-height:1;
               cursor:pointer;padding:0 6px;font-family:inherit}
.modal-head .x:hover{color:#fff}
.modal-body{padding:1.25rem 1.3rem;max-height:68vh;overflow-y:auto}
.modal-foot{padding:1rem 1.3rem;border-top:1px solid var(--border);background:var(--surface2);
            display:flex;gap:9px;flex-wrap:wrap;justify-content:flex-end}
@media(max-width:600px){.modal-foot .btn{width:100%}}
.sec-title{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--red);
           margin:20px 0 9px;padding-bottom:5px;border-bottom:1px solid var(--border)}
.sec-title:first-child{margin-top:0}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:11px 18px}
.kv .k{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.kv .v{font-size:14.5px;color:var(--text);font-weight:600;margin-top:2px;word-break:break-word}

.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);
       background:var(--dark);color:#fff;border-radius:var(--radius-lg);padding:14px 22px;
       font-size:14.5px;font-weight:700;pointer-events:none;opacity:0;z-index:99999;max-width:90vw;
       text-align:center;white-space:pre-line;box-shadow:0 8px 28px rgba(0,0,0,.3);
       transition:opacity .2s,transform .2s}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.success{background:#155724}
.toast.error{background:var(--red)}
```

### Bloco de assinatura desenhada

Substitui "digite seu nome para confirmar", que não prova nada.

```css
.assin-box{border:2px dashed var(--border2);border-radius:var(--radius);background:#fff;
           position:relative;overflow:hidden}
.assin-box canvas{display:block;width:100%;height:160px;touch-action:none;cursor:crosshair}
.assin-box .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
               font-size:14px;color:#B8B2AA;font-style:italic;pointer-events:none;text-align:center;padding:0 12px}
.assin-box.tem .ph{display:none}
.assin-card{display:flex;align-items:center;gap:14px;border:1px solid var(--border);
            background:var(--surface2);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px}
.assin-card img{height:52px;width:auto;max-width:180px;object-fit:contain;background:#fff;
                border:1px solid var(--border);border-radius:6px;padding:2px 6px;flex-shrink:0}

/* Confirmação: alvo grande, vira verde com um visto */
.confirmar{display:flex;align-items:center;gap:14px;margin-top:14px;padding:16px 18px;min-height:64px;
           border:2.5px solid var(--border2);border-radius:var(--radius-lg);background:var(--surface);
           cursor:pointer;transition:all .15s;user-select:none}
.confirmar input{position:absolute;opacity:0;width:0;height:0}
.confirmar .mark{width:34px;height:34px;border-radius:8px;border:2.5px solid var(--border2);background:#fff;
                 flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s}
.confirmar .mark::after{content:"";width:16px;height:9px;border-left:4px solid #fff;border-bottom:4px solid #fff;
                        transform:rotate(-45deg) translate(1px,-2px);opacity:0;transition:opacity .15s}
.confirmar .txt{font-size:15.5px;font-weight:800;color:var(--muted);letter-spacing:.02em}
.confirmar.ok{border-color:var(--st-out);background:var(--st-out-bg)}
.confirmar.ok .mark{background:var(--st-out);border-color:var(--st-out)}
.confirmar.ok .mark::after{opacity:1}
.confirmar.ok .txt{color:var(--st-out)}
```

---

## Esqueleto HTML

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Nome do Formulário — Perpec Oilfield Supply</title>
<!-- scripts na ordem da seção "Arquivos do projeto" -->
<script> /* CONFIG — ponto único de manutenção */ </script>
<style> /* design system */ </style>
</head>
<body>

<!-- Tela de entrada, VISÍVEL por padrão no Perfil B -->
<div class="gate" id="gate">…</div>

<div class="sticky-top">
  <header class="site-header">…logo + título…</header>
  <div class="doc-strip">…código do documento + relógio…</div>
  <div class="user-strip">…quem está logado + estado da sincronização…</div>
  <nav class="tabs"><div class="tabs-inner">…</div></nav>
</div>

<main class="wrap">
  <section class="pane on" id="pane-novo">…formulário em passos numerados…</section>
  <section class="pane" id="pane-abertos">…</section>
  <section class="pane" id="pane-historico">…filtros + tabela + exportação…</section>
  <div class="page-footer">Perpec Oilfield Supply — <span id="ftDoc"></span></div>
</main>

<div class="modal" id="modal" hidden>…</div>
<div class="toast" id="toast"></div>
<script> /* aplicação */ </script>
</body>
</html>
```

**Regra de ouro do gate:** no Perfil B ele começa **visível** (sem `hidden`) e só é escondido
depois da sessão confirmada. Nenhum dado pode piscar na tela antes da identificação.

---

## Convenções de JavaScript

### 1. Bloco `CONFIG` único no topo

Tudo que um dia alguém vai querer ajustar sem entender o código fica aqui, comentado:

```js
const CONFIG = {
  DOC_REF: "FP-XXX-0000 RevForm.00",
  LOGO_URL: "PERPEC - LOGO PRINCIPAL.png",
  PREFIXO_REGISTRO: "XXX",
  DB_KEY: "perpec.<projeto>.v1",

  // Limiares, tolerâncias e listas de apoio — sempre com comentário
  // dizendo o que acontece se o número mudar.
  TOLERANCIA_FUTURO_MIN: 5,
  SETORES: [ "Engenharia", "Qualidade (SGQ)", "…" ],

  // Textos longos (termos, declarações) ficam aqui, não espalhados no HTML.
  TERMO: "Confirmo que …"
};
```

### 2. Camadas

```
config.js   → só dados de conexão
sync.js     → autenticação, fila offline, tradução tela ↔ banco
index.html  → CONFIG, design system, render, regras de negócio
```

O `index.html` **nunca** chama o Supabase direto. Toda gravação passa por uma função
explícita (`PORTARIA.criarRegistro`, `PORTARIA.atualizarRegistro`), para ficar visível no
código o que sai da máquina.

### 3. Nomes

- Funções e variáveis em **português**, como o domínio: `salvarEntrada`, `permanenciaMs`,
  `placaValida`, `souGestor`.
- Tela usa **camelCase** (`porteiroEntrada`), banco usa **snake_case** (`porteiro_entrada`).
  A tradução acontece num único par de funções, `paraBanco()` / `doBanco()`.
- Prefixos de id: `f` = campo do formulário (`fPessoa`), `w` = wrapper do campo (`wPessoa`),
  `m` = mensagem de erro (`mPessoa`). Isso permite marcar erro genericamente:

```js
function marcarErro(campo,msg){
  const w=document.getElementById('w'+campo); if(!w) return;
  w.classList.toggle('err',!!msg);
  const m=document.getElementById('m'+campo); if(m) m.textContent=msg||'';
}
```

### 4. Utilitários obrigatórios

```js
// XSS: tudo que vem do usuário passa por aqui antes de virar innerHTML.
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,
  c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// UUID: chave primária no servidor.
function uid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const r=Math.random()*16|0, v=c==='x'?r:((r&0x3)|0x8); return v.toString(16); });
}

// Comparação tolerante a acento, caixa e espaço.
function chave(s){ return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'')
  .toLowerCase().replace(/\s+/g,' ').trim(); }

const p2 = n => String(n).padStart(2,'0');
function toInputDT(iso){ if(!iso) return ''; const d=new Date(iso); if(isNaN(d)) return '';
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+'T'+p2(d.getHours())+':'+p2(d.getMinutes()); }
function fromInputDT(v){ if(!v) return null; const d=new Date(v); return isNaN(d)?null:d.toISOString(); }
function fmtDT(iso){ if(!iso) return '—'; const d=new Date(iso); if(isNaN(d)) return '—';
  return p2(d.getDate())+'/'+p2(d.getMonth()+1)+'/'+d.getFullYear()+' '+p2(d.getHours())+':'+p2(d.getMinutes()); }

function showToast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast'+(type?' '+type:''); el.classList.add('show');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),4500);
}
```

### 5. Situação e cor num só lugar

Nunca decida cor no meio do render. Uma função é a fonte única:

```js
function situacao(r){
  if(r.status!=='aberto') return 'out';
  const h=permanenciaMs(r)/3600000;
  if(h>=CONFIG.CRITICO_H) return 'late';
  if(h>=CONFIG.ALERTA_H)  return 'warn';
  return 'in';
}
const ROTULO_SIT={ in:'Em andamento', warn:'Atenção', late:'Crítico', out:'Concluído' };
```

Cartão, tabela, contador de aba, painel de resumo e PDF consomem essa função.

### 6. Validação

Valide tudo de uma vez, marque todos os campos com erro, foque o primeiro e mostre um toast
único. Nunca uma cascata de `alert()`.

```js
let erro=false, foco=null;
const falha=(campo,msg)=>{ marcarErro(campo,msg); erro=true; foco=foco||campo; };
if(pessoa.length<3) falha('Pessoa','Escreva o nome de quem entrou.');
…
if(erro){
  const el=document.querySelector('#w'+foco+' input, #w'+foco+' select');
  if(el){ el.focus(); el.scrollIntoView({block:'center',behavior:'smooth'}); }
  showToast('Faltou preencher. Veja os campos em vermelho.','error');
  return;
}
```

### 7. Rascunho automático

Um F5 acidental não pode custar 10 campos digitados:

```js
const CAMPOS_FORM=['fPessoa','fEmpresa','…'];
function salvarRascunho(){ const d={}; CAMPOS_FORM.forEach(id=>d[id]=document.getElementById(id).value);
                           DB.rascunho=d; dbSalvar(); }
CAMPOS_FORM.forEach(id=>document.getElementById(id).addEventListener('input',salvarRascunho));
```

---

## Camada de dados (Supabase)

### Princípio

> A página é pública e todo o JavaScript é visível, inclusive a chave `anon`.
> **A proteção está no banco, nunca na tela.** O que a interface esconde é conforto.

### Estrutura do `sync.js`

```js
window.PROJETO = (function(){
  'use strict';
  const CFG = window.SUPABASE_CONFIG || {};
  let sb=null, perfil=null, estado='offline';

  // A biblioteca acrescenta /rest/v1 sozinha — remova se vier no config.
  function urlBase(u){ return String(u||'').trim().replace(/\/+$/,'')
    .replace(/\/(rest|auth|storage|realtime)\/v1$/i,'').replace(/\/+$/,''); }

  // ---- fila offline (outbox) ----
  function fila(){ try{ return JSON.parse(localStorage.getItem(CHAVE_FILA)||'[]'); }catch(e){ return []; } }
  function enfileirar(tipo,payload){ const f=fila();
    f.push({fid:'f'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),tipo,payload});
    gravarFila(f); avisar(); }

  // ---- envio: relê a fila a cada volta, senão perde item enfileirado durante o envio ----
  async function descarregar(){
    if(enviando) return; enviando=true;
    try{
      while(true){
        const f=fila(); if(!f.length) break;
        const item=f[0]; let remover=false;
        try{ await executar(item); remover=true; }
        catch(e){
          const permanente = e && e.code && !/fetch|network|Failed/i.test(e.message||'');
          if(permanente) remover=true; else break;   // rede: tenta de novo depois
        }
        if(remover){ const a=fila(); const i=a.findIndex(x=>x.fid===item.fid);
                     if(i>=0){ a.splice(i,1); gravarFila(a); } }
      }
    } finally { enviando=false; avisar(); }
  }

  return { iniciar, entrar, sair, puxarTudo, puxarNovidades,
           criarRegistro, atualizarRegistro, apagarRegistro, auditar,
           descarregar, ligarSondagem, aoMudar,
           get perfil(){return perfil}, get gestor(){return !!perfil&&perfil.papel==='gestor'} };
})();
```

### Regras da camada

1. **Servidor é a fonte da verdade**; `localStorage` é cache + outbox, nada mais.
2. **Toda gravação passa pela fila**, mesmo online. Um só caminho, testado o tempo todo.
3. **Sondagem**: incremental a cada 30 s (`atualizado_em > ultimaSync`), completa a cada
   5 min (detecta exclusões), imediata em `online` e `focus`.
4. **Numeração sequencial vem do servidor**, nunca do aparelho. Offline gera provisório
   (`XXX-2026-P001`), marcado na tela, promovido no envio.
5. **Erro permanente ≠ erro de rede.** Erro de rede fica na fila; violação de regra sai da
   fila com aviso, senão ela trava para sempre.
6. **Ao sair, apague o cache local.** Aparelho compartilhado não pode guardar dado de
   terceiro para o próximo usuário.

### Login por matrícula

O Supabase autentica por e-mail. Matrícula vira e-mail interno:

```js
const emailDe = mat => String(mat).replace(/\D/g,'') + '@' + CFG.DOMINIO_LOGIN;
const ehEmail = v => /@/.test(String(v||''));
const loginParaEmail = v => ehEmail(v) ? String(v).trim().toLowerCase() : emailDe(v);
```

Exige **Confirm email desligado** no painel. Mensagem de erro: genérica para credencial
errada, específica para problema de instalação — esconder erro de setup só faz perder tempo.

---

## Esquema SQL modelo

Adapte os nomes; mantenha a estrutura.

```sql
create extension if not exists pgcrypto;

-- ---------- 1. PERFIS ----------
create table if not exists public.perfis (
  id            uuid primary key references auth.users(id) on delete cascade,
  matricula     text not null unique check (matricula ~ '^[0-9]{1,10}$'),
  nome          text not null check (char_length(btrim(nome)) >= 5),
  papel         text not null default 'operador' check (papel in ('operador','gestor')),
  assinatura    text,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- ---------- 2. FUNÇÕES DE APOIO ----------
-- security definer para lerem public.perfis sem cair na própria RLS
-- (evita recursão infinita nas políticas). search_path SEMPRE fixado.
create or replace function public.sou_ativo()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select ativo from public.perfis where id = auth.uid()), false) $$;

create or replace function public.sou_gestor()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select papel='gestor' and ativo from public.perfis where id=auth.uid()), false) $$;

create or replace function public.minha_matricula()
returns text language sql stable security definer set search_path = public as $$
  select matricula from public.perfis where id = auth.uid() and ativo $$;

-- ---------- 3. TABELA PRINCIPAL ----------
create table if not exists public.registros (
  id             uuid primary key default gen_random_uuid(),
  numero         text not null unique,
  provisorio     boolean not null default false,
  status         text not null default 'aberto' check (status in ('aberto','concluido')),

  -- … campos do domínio …
  documento      text,                       -- SENSÍVEL: sem GRANT de SELECT

  -- Máscara calculada pelo banco: é ela que a tela recebe.
  documento_mascarado text generated always as (
    case when documento is null or btrim(documento)='' then null
         when char_length(btrim(documento))<=4 then repeat('•',char_length(btrim(documento)))
         else repeat('•',char_length(btrim(documento))-4) || right(btrim(documento),4) end
  ) stored,

  matricula_autor text not null,
  selo           text,
  criado_em      timestamptz not null default now(),
  criado_por     uuid not null default auth.uid(),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid not null default auth.uid()
);
create index if not exists registros_atualizado_idx on public.registros (atualizado_em desc);

-- ---------- 4. AUDITORIA (append-only) ----------
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

-- ---------- 5. NUMERAÇÃO NO SERVIDOR ----------
create table if not exists public.contadores (ano integer primary key, ultimo integer not null default 0);

create or replace function public.proximo_numero()
returns text language plpgsql security definer set search_path = public as $$
declare v_ano integer := extract(year from now() at time zone 'America/Sao_Paulo'); v_n integer;
begin
  if not public.sou_ativo() then raise exception 'Usuário sem permissão.'; end if;
  insert into public.contadores(ano,ultimo) values (v_ano,1)
    on conflict (ano) do update set ultimo = public.contadores.ultimo + 1
    returning ultimo into v_n;
  return 'XXX-' || v_ano || '-' || lpad(v_n::text,4,'0');
end $$;

-- ---------- 6. LEITURA DE DADO SENSÍVEL, SEMPRE AUDITADA ----------
create or replace function public.revelar_documento(p_registro uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_doc text;
begin
  if not public.sou_gestor() then raise exception 'Somente gestores.'; end if;
  select documento into v_doc from public.registros where id = p_registro;
  insert into public.auditoria(registro_id,evento,detalhe,autor,matricula)
  values (p_registro,'DOCUMENTO CONSULTADO','Valor completo exibido.',
          (select nome from public.perfis where id=auth.uid()), public.minha_matricula());
  return v_doc;
end $$;

-- ---------- 7. GATILHOS DE INVARIANTE ----------
create or replace function public.tg_carimbo()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.atualizado_em:=now(); new.atualizado_por:=auth.uid();
  new.criado_em:=old.criado_em; new.criado_por:=old.criado_por;   -- imutáveis
  return new;
end $$;
drop trigger if exists registros_carimbo on public.registros;
create trigger registros_carimbo before update on public.registros
  for each row execute function public.tg_carimbo();

-- ---------- 8. PERMISSÃO POR COLUNA ----------
-- O Supabase concede tudo por padrão. Derrube e devolva coluna a coluna:
-- é ISTO que impede a leitura de "documento".
revoke all on public.perfis, public.registros, public.auditoria, public.contadores
  from anon, authenticated;

grant select (id, numero, status, documento_mascarado, matricula_autor, selo,
              criado_em, atualizado_em)                on public.registros to authenticated;
grant insert (id, numero, status, documento, matricula_autor, selo)
                                                        on public.registros to authenticated;
grant update (status, documento, selo)                  on public.registros to authenticated;
grant delete                                            on public.registros to authenticated;

grant select (id,registro_id,ts,evento,detalhe,autor,matricula,autor_id) on public.auditoria to authenticated;
grant insert (registro_id,evento,detalhe,autor,matricula)                on public.auditoria to authenticated;
-- sem grant de update/delete: ninguém altera a auditoria pela API

grant execute on function public.proximo_numero()        to authenticated;
grant execute on function public.revelar_documento(uuid) to authenticated;

-- ---------- 9. ROW LEVEL SECURITY ----------
alter table public.perfis     enable row level security;
alter table public.registros  enable row level security;
alter table public.auditoria  enable row level security;
alter table public.contadores enable row level security;   -- sem política = ninguém acessa

create policy reg_ler    on public.registros for select to authenticated using (public.sou_ativo());
create policy reg_criar  on public.registros for insert to authenticated
  with check (public.sou_ativo() and matricula_autor = public.minha_matricula());
create policy reg_alterar on public.registros for update to authenticated
  using (public.sou_ativo()) with check (public.sou_ativo());
create policy reg_apagar on public.registros for delete to authenticated using (public.sou_gestor());

create policy aud_ler   on public.auditoria for select to authenticated using (public.sou_ativo());
create policy aud_criar on public.auditoria for insert to authenticated with check (public.sou_ativo());

-- ---------- 10. DESCARTE (LGPD) ----------
create or replace function public.anonimizar_antigos(p_meses integer default 24)
returns integer language plpgsql security definer set search_path = public as $$
declare v_qtd integer;
begin
  if not public.sou_gestor() then raise exception 'Somente gestores.'; end if;
  update public.registros set documento=null
   where documento is not null and criado_em < now() - (p_meses||' months')::interval;
  get diagnostics v_qtd = row_count;
  insert into public.auditoria(evento,detalhe,autor,matricula)
  values ('DESCARTE LGPD', v_qtd||' registro(s) anonimizados.',
          (select nome from public.perfis where id=auth.uid()), public.minha_matricula());
  return v_qtd;
end $$;
```

### Instalação do projeto Supabase

1. Criar projeto — região **South America (São Paulo)**, por causa da LGPD.
2. `SQL Editor` → colar o esquema → `Run`.
3. `Authentication` → `Providers` → `Email`: desligar **Confirm email**, manter
   **Allow new users to sign up** (é por ele que o gestor cria usuários pela tela).
4. `config.js`: **Project URL** (sem `/rest/v1/`) e chave **anon**. Jamais a `service_role`.
5. Primeiro gestor: criar em `Authentication` → `Users` → `Add user` com *Auto Confirm*, e
   inserir a linha em `perfis` por SQL. O `INSERT` só funciona se o usuário já existir —
   rodado antes, não insere nada e não avisa.

Deixe no fim do `.sql` um bloco **DIAGNÓSTICO** comentado, com a consulta que junta
`auth.users` e `perfis` — economiza horas quando o login não funciona.

---

## Geração de PDF (jsPDF)

### Estrutura padrão

```js
function gerarPDF(id){
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
  const W=210,H=297,ML=14,MR=14,CW=W-ML-MR;
  const DARK=[26,18,16],GRAY=[135,130,125],RED=[192,57,43],LGRAY=[224,219,213];
  const setC=c=>doc.setTextColor(...c), setD=c=>doc.setDrawColor(...c);
  const logoB64=window.LOGO_B64||'';

  function header(){
    if(logoB64){ try{ doc.addImage(logoB64,'PNG',ML,4,40,11); }catch(e){} }
    setD(RED); doc.setLineWidth(0.8); doc.line(0,19,W,19);
    doc.setFontSize(12); doc.setFont('helvetica','bold'); setC(DARK);
    doc.text('TÍTULO DO DOCUMENTO',W-MR,10,{align:'right'});
    doc.setFontSize(7.5); doc.setFont('helvetica','normal'); setC(GRAY);
    doc.text(r.numero+'  •  emitido em '+fmtDT(new Date().toISOString()),W-MR,15.5,{align:'right'});
  }
  function footer(){
    const pg=doc.internal.getCurrentPageInfo().pageNumber, tot=doc.internal.getNumberOfPages();
    doc.setFontSize(6.5); doc.setFont('helvetica','italic'); setC([170,165,160]);
    doc.text('Perpec Oilfield Supply  •  '+CONFIG.DOC_REF,W/2,H-7,{align:'center'});
    doc.setFont('helvetica','normal'); doc.text('Página '+pg+' de '+tot,W-MR,H-7,{align:'right'});
  }

  header(); let y=26;

  function tabela(titulo,dados){
    doc.autoTable({
      startY:y, margin:{left:ML,right:MR,top:24,bottom:16},
      head:[[{content:titulo,colSpan:2,styles:{halign:'left',fillColor:DARK,
              textColor:[240,230,228],fontSize:7.5,fontStyle:'bold'}}]],
      body:dados.map(l=>[l[0],l[1]||'—']),
      styles:{fontSize:9,cellPadding:2.2,lineColor:LGRAY,lineWidth:0.1,valign:'top',overflow:'linebreak'},
      columnStyles:{0:{cellWidth:52,fontStyle:'bold',textColor:GRAY},1:{cellWidth:CW-52,textColor:DARK}},
      didDrawPage:()=>{ footer(); }
    });
    y=doc.lastAutoTable.finalY+4;
  }

  tabela('SEÇÃO',[['Campo','valor'],…]);

  // Cabeçalho e rodapé em TODAS as páginas — inclusive as que o autoTable
  // criou sozinho ao estourar a página.
  const tot=doc.internal.getNumberOfPages();
  for(let i=1;i<=tot;i++){ doc.setPage(i); header(); footer(); }

  doc.save('Documento-'+r.numero+'.pdf');
}
```

### Regras

- Logo sempre de `window.LOGO_B64`; `addImage` dentro de `try/catch`.
- Assinatura desenhada entra como imagem, acima de uma linha, com nome e data ao lado.
- Texto de termo em itálico, **sem aspas**.
- Rodapé com referência do documento e "Página X de Y".
- Nada de tarja colorida de status no PDF: relatório impresso é documento formal.
- Dado sensível sai **mascarado** no PDF e no CSV.

### Exportação CSV

```js
const q=v=>'"'+String(v==null?'':v).replace(/"/g,'""').replace(/\r?\n/g,' ')+'"';
// BOM + separador ";" para o Excel em português abrir direto
baixarArquivo(nome+'.csv', '﻿'+cab.map(q).join(';')+'\r\n'+linhas.join('\r\n'),
              'text/csv;charset=utf-8');
```

---

## Regras de UX

O público destes formulários inclui pessoas com pouca escolaridade e uso em pé, muitas vezes
no celular. Isso não é detalhe: é requisito.

1. **Linguagem direta.** "Nome de quem entrou", não "Identificação do portador". "Já saíram",
   não "Registros concluídos". "Exportar para Excel", não "Exportar CSV".
2. **Passos numerados** nos cards do formulário (`.step`), orientando a ordem sem exigir leitura.
3. **Cor com significado fixo**, igual em toda a aplicação, com **legenda visível na tela**.
   Nunca use cor só de enfeite.
4. **Alvos grandes**: campos com 16px, botões com 46px de altura mínima, ação principal com 58px.
5. **Uma ação primária por tela**, em vermelho e caixa alta.
6. **Erro aponta o campo**: borda vermelha, mensagem embaixo, rolagem até ele, um toast só.
7. **Confirmação é toque**, não digitação. Botão grande que fica verde com um visto.
8. **Assinatura é desenho**, não nome redigitado.
9. **Números grandes e clicáveis** no painel de resumo, servindo de filtro.
10. **Estado do sistema sempre visível**: quem está logado, se sincronizou, quantos itens
    esperam envio.

---

## Checklist antes de publicar

**Segurança**
- [ ] Nenhuma chave `service_role` no repositório
- [ ] RLS ligada em todas as tabelas; nenhuma política atende `anon`
- [ ] Colunas sensíveis sem `GRANT` de `SELECT`, com máscara gerada no banco
- [ ] Leitura de dado sensível só por função `security definer`, auditada
- [ ] `auditoria` sem `GRANT` de `update`/`delete`
- [ ] `criado_por` / `atualizado_por` preenchidos por gatilho, não pelo cliente
- [ ] Todo texto do usuário passa por `esc()` antes de virar `innerHTML`
- [ ] Gate de login começa visível
- [ ] Sair apaga o cache local

**Funcionamento**
- [ ] Numeração vem do servidor; offline gera provisório marcado na tela
- [ ] Fila offline relê o armazenamento a cada volta (senão perde item)
- [ ] Erro de rede fica na fila; erro permanente sai com aviso
- [ ] Rascunho do formulário sobrevive a F5
- [ ] `beforeunload` avisa se há item pendente

**Interface**
- [ ] Testado em celular real, não só no redimensionador do navegador
- [ ] Campos com 16px (senão o iOS dá zoom)
- [ ] Legenda de cores visível
- [ ] PDF com logo, em `file://` e em `https://`
- [ ] CSV abre no Excel em português sem passo de importação

**Entrega**
- [ ] `README.md` com instalação, uso diário, armazenamento, segurança e problemas comuns
- [ ] Bloco `DIAGNÓSTICO` comentado no `.sql`
- [ ] `CONFIG` no topo do `index.html`, com comentário em cada parâmetro
- [ ] Testado com `Ctrl+F5` depois de publicar (GitHub Pages guarda cache de `.js`)

---

*Extraído do FP-ADM-0002 — Controle de Entrada de Veículos · Perpec Oilfield Supply*
