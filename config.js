/* ============================================================
   CONEXÃO COM O BANCO (Supabase)
   ------------------------------------------------------------
   Preencha os dois valores abaixo com os dados do seu projeto:
     Supabase → Project Settings → Data API
       Project URL      -> SUPABASE_URL
     Supabase → Project Settings → API Keys
       anon / public    -> SUPABASE_ANON_KEY

   ATENÇÃO NA URL: use só o endereço do projeto, SEM caminho no fim.
       certo:  https://abcdefgh.supabase.co
       errado: https://abcdefgh.supabase.co/rest/v1/
   O "/rest/v1/" é acrescentado sozinho pela biblioteca. Se ficar aqui,
   toda chamada vai para .../rest/v1/rest/v1/... e falha.

   A chave "anon" PODE ficar visível aqui e no GitHub. Ela não dá
   acesso a nada sozinha: toda tabela tem Row Level Security ligada
   e nenhuma política atende usuário anônimo. Sem login com matrícula
   e senha, esta chave não lê nem grava um único registro.

   NUNCA coloque aqui a chave "service_role". Essa sim ignora todas
   as regras de segurança e jamais deve sair do servidor.
   ============================================================ */
window.SUPABASE_CONFIG = {
  SUPABASE_URL:      "https://aqvyuzccvmlcchtznypt.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxdnl1emNjdm1sY2NodHpueXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNTgwNjYsImV4cCI6MjEwMjYzNDA2Nn0.JkiUPD-S6PqpSUwNZh7UvVTqDraDpU2Z0yE5tf7CmvI",

  // Domínio interno usado para transformar a matrícula em e-mail de login.
  // Não precisa existir de verdade — nenhuma mensagem é enviada.
  DOMINIO_LOGIN: "portaria.perpec.local"
};
