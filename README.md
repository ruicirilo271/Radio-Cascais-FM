# Rádio Cascais — Super Deus (Vercel)

Versão preparada para Vercel sem FFmpeg e sem processos permanentes em background.

## O que mudou

- A amostra MP3 é captada diretamente do stream para `/tmp`.
- A identificação é feita por Shazam apenas quando o browser pede, evitando threads que morrem no ambiente serverless.
- A rádio toca diretamente do stream original, por isso não fica dependente do tempo máximo de uma função Vercel.
- A chave do YouTube deixou de ficar exposta no JavaScript.
- Histórico das últimas 10 músicas e Top 10 ficam no `localStorage` do browser.
- Nova interface “Modo Super Deus”, responsiva e otimizada.

## Estrutura

```text
app.py
templates/index.html
static/style.css
static/script.js
static/default-cover.webp
requirements.txt
vercel.json
.env.example
```

## Publicar no Vercel

1. Envia esta pasta para um repositório GitHub.
2. No Vercel, escolhe **Add New → Project** e importa o repositório.
3. Em **Settings → Environment Variables**, adiciona:
   - `LASTFM_API_KEY`
   - `YOUTUBE_API_KEY`
4. Faz **Redeploy**.

O `RADIO_STREAM_URL` já tem um valor padrão, mas também pode ser definido nas variáveis de ambiente.

## Correr no computador

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python app.py
```

No modo local, exporta as variáveis no terminal ou usa uma ferramenta como `python-dotenv` caso desejes carregar o `.env` automaticamente.

## Notas

- Não é necessário instalar FFmpeg.
- O estado da música em memória pode reiniciar quando a função Vercel muda de instância; o histórico do utilizador permanece no browser.
- O visualizador tenta usar áudio real. Se o servidor do stream bloquear análise CORS, passa automaticamente para uma animação sincronizada visualmente, sem impedir a reprodução.
