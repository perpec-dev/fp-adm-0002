/* ============================================================
   CONEXÃO COM O BANCO (Supabase)
   ------------------------------------------------------------
   Preencha os dois valores abaixo com os dados do seu projeto:
     Supabase → Project Settings → Data API
       URL              -> SUPABASE_URL
       anon / public    -> SUPABASE_ANON_KEY

   A chave "anon" PODE ficar visível aqui e no GitHub. Ela não dá
   acesso a nada sozinha: toda tabela tem Row Level Security ligada
   e nenhuma política atende usuário anônimo. Sem login com matrícula
   e senha, esta chave não lê nem grava um único registro.

   NUNCA coloque aqui a chave "service_role". Essa sim ignora todas
   as regras de segurança e jamais deve sair do servidor.
   ============================================================ */
window.SUPABASE_CONFIG = {
  SUPABASE_URL:      "https://SEU-PROJETO.supabase.co",
  SUPABASE_ANON_KEY: "COLE-AQUI-A-CHAVE-ANON",

  // Domínio interno usado para transformar a matrícula em e-mail de login.
  // Não precisa existir de verdade — nenhuma mensagem é enviada.
  DOMINIO_LOGIN: "portaria.perpec.local"
};
