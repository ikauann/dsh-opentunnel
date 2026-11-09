# dsh-opentunnel

Uma rota HTTPS pública para o GUI Web do DSH, ligada e desligada por um
interruptor em **Configurações → OpenTunnel**, com QR code para entrar pelo
celular. Sem VPN, sem app no telefone, sem abrir porta no roteador.

![Seção OpenTunnel em Configurações](opentunnel-settings.png)

## Como se usa

1. **Configurações → OpenTunnel** (no menu da conta, no pé da barra lateral).
2. Ligue **Túnel público**. Na primeira vez leva uns 30 s: o túnel é criado e o
   certificado é emitido por ACME. Da segunda vez anexa em segundos.
3. Aponte a câmera do celular para o QR. Ele abre a URL com o token desta
   sessão; o DSH troca por um cookie assinado de 30 dias e o celular entra
   direto — depois disso é só abrir a URL, sem token.
4. Desligue o interruptor quando não precisar. A rota pública morre na hora.

O DSH também imprime o link no terminal, na mesma linha de boot:

```
dsh web: http://127.0.0.1:3080/?token=…
dsh opentunnel: https://dyoe4ezc2nvm.opentunnel.xyz/?token=…
```

E grava o mesmo link em `$DSH_HOME/opentunnel-link.txt` (modo 600).

## Por que existe um proxy no meio

O DSH tranca o `/api` por um fence de `Host`/`Origin`: aceita loopback, o IP de
bind do listener e o que estiver em `trustedHosts` — que é valor de boot
(`--trusted-host`). O túnel entrega o `Host` do visitante intacto (medido), então
o fence responderia **403** em todo `/api` e o GUI carregaria sem back-end.

O plugin põe um proxy em loopback na frente do listener e aponta o túnel para
ele. O proxy reescreve `Host` e `Origin` para `127.0.0.1:<porta>` e deixa o
resto passar — inclusive `sec-fetch-site`, que é o que barra CSRF de verdade.
Resultado: o visitante parece o que é, uma requisição local, e **nenhuma flag é
necessária**.

Consequência a saber: o cookie fica preso a `127.0.0.1:<porta>`. Se você mudar a
porta do listener, os cookies antigos param de valer e o celular precisa do QR
de novo.

## Instalação

No `package.json` do profile (`$DSH_HOME/profiles/web/package.json`):

```json
{
  "dependencies": {
    "@ikauann/dsh-opentunnel": "link:C:/caminho/para/dsh-opentunnel"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "@ikauann/dsh-opentunnel"]
    }
  }
}
```

Para instalar de um clone do repositório em vez de um `link:`, troque a
dependência por `"github:ikauann/dsh-opentunnel"` e mantenha a entrada em
`bundles` — o nome do pacote é o que a linha do bundle procura.

Depois instale e **reinicie** (o bundle de servidor e o módulo de cliente só
entram num boot novo):

```powershell
$env:DSH_HOME="$HOME\.dsh"
dsh plugin --profile web install
dsh --profile web
```

## Configuração

| chave | padrão | o que faz |
| --- | --- | --- |
| `enabled` | `true` | Estado **do primeiro boot**. Depois disso, quem manda é o interruptor. |
| `routeName` | `@` | `@` serve o hostname do túnel; um rótulo DNS serve `<rota>.<hostname>`. |
| `profile` | `dsh` | Nome do profile do OpenTunnel que guarda a identidade (token + chave + cert). |
| `api` | `""` | Control plane; vazio segue `$OPENTUNNEL_API`, depois `opentunnel.xyz`. |
| `proxy` | `""` | Proxy HTTP para control plane e bridge; vazio segue o ambiente. |
| `rewrite` | `true` | Proxy de reescrita. Desligar exige `--trusted-host <host do túnel>`. |
| `rewritePort` | `0` | Porta do proxy; `0` pede uma ao SO. |
| `targetPort` | `0` | Alvo do proxy; `0` lê a porta viva do listener. |
| `panelPath` | `/opentunnel` | Família de rotas que a página consome. |
| `linkFile` | `""` | Onde gravar o link com token; vazio usa `$DSH_HOME/opentunnel-link.txt`. |
| `printLink` | `true` | Imprime o link no terminal quando a rota anexa. |
| `persist` | `true` | Guarda a escolha do interruptor em `$DSH_HOME/opentunnel.json`. |

### Rotas que a página usa

Todas exigem o header `x-dsh-opentunnel`, cujo valor o Host injeta no documento
(e só um documento autenticado carrega o index):

| rota | o que faz |
| --- | --- |
| `GET /opentunnel/state` | estado, URL, porta do proxy, erro |
| `POST /opentunnel/enable` | abre a rota |
| `POST /opentunnel/disable` | fecha a rota |
| `GET /opentunnel/link` | URL com token (409 enquanto não anexa) |
| `GET /opentunnel/qr` | o mesmo link como SVG de QR |

### Sem o proxy

Se preferir não ter o salto extra, desligue `rewrite` e suba o listener
confiando no host do túnel:

```powershell
dsh --profile web --trusted-host dyoe4ezc2nvm.opentunnel.xyz --public-url https://dyoe4ezc2nvm.opentunnel.xyz
```

`--public-url` só anuncia; `--trusted-host` é quem libera a autoridade no fence.

## Segurança

- Sem token, a URL pública responde **401** em tudo — medido.
- O QR carrega o token da sessão. Quem tem URL + token tem o agente inteiro, ou
  seja execução de código nesta máquina. Ele fica no terminal, no
  `opentunnel-link.txt` (modo 600) e na página de Configurações — **nunca** no
  contexto do modelo.
- O QR é renderizado no Host, atrás do token da página, e chega como SVG por
  fetch: o link não vira URL de `<img>` que terceiros possam logar.
- Revogar = desligar o interruptor ou reiniciar o DSH (o token muda a cada
  processo).
- O certificado HTTPS termina neste processo (é o TLS do OpenTunnel, chave
  privada nunca sai daqui); o relay não vê plaintext.
- Hostname de rota não aparece em Certificate Transparency, e `*.opentunnel.xyz`
  só resolve para túneis que existem.

## Limitações

- O CLI do OpenTunnel (Rust) só tem binário para Linux e macOS. No Windows este
  plugin usa o SDK TypeScript, que roda em Node — foi o caminho validado.
- Uma rota pertence a um bridge por vez: se outro cliente estiver na mesma rota,
  o SDK fica re-tentando e assume quando ela soltar.
- O túnel não autentica ninguém; quem autentica é o token do DSH.

## Verificação

Duas provas, ambas contra um listener real e um túnel real:

```powershell
# Host: interruptor, guards, link, QR, fluxo do celular e upgrade de WebSocket
$env:DSH_CLI_ROOT="$(npm root -g)\@deepseek-ai\dsh"
$env:XDG_DATA_HOME="$PWD\.data"   # identidade de teste em vez da sua
node --import ./test/loader.mjs test/smoke.mjs <token-do-DSH> <porta>

# Cliente: registro nos slots e primeira renderização da seção, sem DOM
node test/client.smoke.mjs
```

O `test/loader.mjs` existe só para o teste: resolve `@deepseek-ai/*` do install
global do CLI (`DSH_CLI_ROOT`), já que o repositório vive fora de um profile —
dentro de um profile esses pacotes resolvem sozinhos.
