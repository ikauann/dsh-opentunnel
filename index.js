/**
 * dsh-opentunnel — Host half.
 *
 * Opens an OpenTunnel route for this DSH Web listener, so the browser GUI can be
 * used from a phone over a public HTTPS URL: no VPN client, no port forwarding,
 * and the listener stays on loopback. The Settings page toggles it at runtime and
 * scans a QR code off the screen.
 *
 * Why a loopback proxy in front of the listener: Connection's Host/Origin fence
 * accepts loopback, the listener's own bind address, and `trustedHosts` — a boot
 * value read from `--trusted-host`. A tunnel forwards the visitor's `Host`
 * unchanged (measured), so the fence would answer 403 on `/api`. Rewriting the
 * two authorities onto loopback keeps the fence's cross-site check intact
 * (`sec-fetch-site` passes through untouched) while making the visitor look like
 * what it is: a loopback request. DSH binds the minted cookie to whatever
 * authority the listener saw, so it stays consistent across the rewrite.
 *
 * The launch token never enters the model context: the tokenised URL goes to
 * stdout, to `linkFile`, and to the Settings page over a token-guarded route.
 *
 * @module @local/dsh-opentunnel
 */
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { renderSVG } from "uqr";

/** Stable Loader identity. */
export const name = "opentunnel";

/** Services the plugin cannot work without. */
export const inject = ["tools", "webServer"];

/** Plugin configuration. */
export const Config = z.object({
  /** State for the first boot; afterwards the Settings toggle is the source of truth. */
  enabled: z.boolean().default(true),
  /**
   * Route name: `@` serves the tunnel hostname itself, a lowercase DNS label
   * serves `<route>.<hostname>`. OpenTunnel requires a fixed name; changing it
   * re-attaches the bridge.
   */
  routeName: z.string().default("@"),
  /** OpenTunnel profile name this machine's tunnel identity lives under. */
  profile: z.string().default("dsh"),
  /** Control-plane override; empty follows `$OPENTUNNEL_API`, then opentunnel.xyz. */
  api: z.string().default(""),
  /** HTTP proxy for the control plane and the bridge; empty follows the environment. */
  proxy: z.string().default(""),
  /**
   * Serve the visitor through a loopback rewriting proxy. Keep it on unless the
   * listener is started with `--trusted-host <tunnel host>`: with the proxy off
   * the fence rejects `/api` for the tunnel authority.
   */
  rewrite: z.boolean().default(true),
  /** Loopback address the rewriting proxy binds. */
  rewriteHost: z.string().default("127.0.0.1"),
  /** Rewriting proxy port; zero asks the OS for one. */
  rewritePort: z.number().default(0),
  /** Port the proxy targets; zero reads the live Web listener port. */
  targetPort: z.number().default(0),
  /** Route family the Settings page and the agent read tunnel state from. */
  panelPath: z.string().default("/opentunnel"),
  /** File the tokenised URL is written to; empty means `$DSH_HOME/opentunnel-link.txt`. */
  linkFile: z.string().default(""),
  /** Print the tokenised URL to stdout when the route attaches. */
  printLink: z.boolean().default(true),
  /** Remember the Settings toggle across restarts, next to the Harness home. */
  persist: z.boolean().default(true),
});

/** Hop-by-hop headers a forwarding proxy owns and must not pass through. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

/** Header the Settings page uses to prove it rendered from this process. */
const PANEL_HEADER = "x-dsh-opentunnel";

/**
 * Path prefix of the durable entry link. DSH's launch token is per process, and
 * the tunnel hostname is stable, so a saved URL dies at every restart. This path
 * answers with a redirect to the current process token instead, which makes one
 * scanned link keep working for the life of the installation.
 */
const ENTRY_PREFIX = "/e/";

/**
 * Headers for one upstream exchange: authorities rewritten onto the loopback
 * target, hop-by-hop fields dropped so the proxy's own framing wins.
 * @param headers - the inbound request headers.
 * @param target - loopback port the Web listener actually listens on.
 * @returns a fresh header record safe to hand to `http.request`.
 */
function upstreamHeaders(headers, target) {
  const authority = `127.0.0.1:${target}`;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "host") continue;
    if (key === "origin") {
      out.origin = `http://${authority}`;
      continue;
    }
    out[key] = value;
  }
  out.host = authority;
  return out;
}

/**
 * A loopback reverse proxy that rewrites `Host` and `Origin` onto itself and
 * carries upgrades through, so both plain requests and the WebSocket stream look
 * local to the listener behind it.
 * @param options - bind address, port, upstream port.
 * @returns the proxy's listening port and a closer.
 */
async function startRewriteProxy(options) {
  const { host, port, targetPort, entry } = options;

  /** The durable entry link, or undefined when this request is an ordinary one. */
  const entryCode = (req) => {
    if (req.method !== "GET") return undefined;
    const path = req.url ?? "";
    if (!path.startsWith(ENTRY_PREFIX)) return undefined;
    return path.slice(ENTRY_PREFIX.length).split("?")[0].replace(/\/+$/, "");
  };

  const forward = (req, res) => {
    const code = entryCode(req);
    if (code !== undefined) {
      // The durable door: a wrong code never reaches the listener, and the right
      // one hands the browser the current process token so the cookie is minted.
      if (entry !== undefined && code.length > 0 && code === entry.code()) {
        const target = entry.url();
        if (target.length > 0) {
          res.writeHead(302, { location: target, "cache-control": "no-store" });
          res.end();
          return;
        }
      }
      res.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      res.end("opentunnel: código de entrada inválido. Abra o QR em Configurações → OpenTunnel.\n");
      return;
    }

    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.headers, targetPort),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`opentunnel proxy: ${error.message}`);
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };

  const forwardUpgrade = (req, socket, head) => {
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: {
        ...upstreamHeaders(req.headers, targetPort),
        // `upstreamHeaders` drops hop-by-hop fields; an upgrade needs its two
        // markers back, or the listener answers an ordinary request.
        connection: "Upgrade",
        upgrade: req.headers.upgrade ?? "websocket",
      },
    });
    upstream.on("upgrade", (answer, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [key, value] of Object.entries(answer.headers)) {
        lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead?.length > 0) socket.write(upstreamHead);
      if (head?.length > 0) upstreamSocket.write(head);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // A refused upgrade is an ordinary response; relay it so the browser sees
    // the listener's own status instead of a dropped socket.
    upstream.on("response", (answer) => {
      const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage ?? "Error"}`];
      for (const [key, value] of Object.entries(answer.headers)) {
        lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      answer.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  };

  const server = createServer(forward);
  server.on("upgrade", forwardUpgrade);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Register the tunnel, the rewriting proxy, the Settings routes and the agent tool. */
export function apply(ctx, config) {
  if (!config.panelPath.startsWith("/")) throw new Error("opentunnel: panelPath must be an absolute path");

  const token = randomUUID();
  const lifetime = new AbortController();

  /** Desired state, distinct from what the bridge is doing right now. */
  let enabled = config.enabled;
  const state = {
    phase: "off",
    url: "",
    host: "",
    proxyPort: 0,
    attachedAt: "",
    error: "",
    events: [],
  };

  let client;
  let connection;
  let rewrite;
  let disposed = false;
  let queue = Promise.resolve();

  /**
   * The durable entry code. DSH's launch token is minted per process, so a saved
   * URL stops working at the next restart even though the hostname and the path
   * look identical. This code is generated once, persisted next to the toggle,
   * and exchanged for the current token by the proxy — one scanned link, forever.
   */
  let entryCode = "";

  /** Where the durable link lands when the configuration names no file. */
  const linkPath = () =>
    config.linkFile.length > 0
      ? config.linkFile
      : join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "opentunnel-link.txt");

  /** Where the toggle and the entry code survive a restart. */
  const statePath = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "opentunnel.json");

  /** Read the remembered preference and entry code once, before the first activation. */
  const readPersisted = () => {
    if (!config.persist) return {};
    try {
      const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
      return {
        enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : undefined,
        entryCode: /^[a-f0-9]{32}$/.test(parsed?.entryCode ?? "") ? parsed.entryCode : undefined,
      };
    } catch {
      return {};
    }
  };

  /** Write the preference and the entry code, best effort: a read-only home must not break the toggle. */
  const persist = () => {
    if (!config.persist) return;
    try {
      const path = statePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ enabled, entryCode }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* the session keeps the choice even when the home cannot */
    }
  };

  const targetPort = () => config.targetPort || ctx.webServer.port;

  const tunnelHost = () => {
    if (state.url.length === 0) return "";
    try {
      return new URL(state.url).hostname;
    } catch {
      return "";
    }
  };

  /** The process launch token, added to a clean URL — Host-independent, so it travels by tunnel. */
  const tokenisedUrl = (clean) => {
    if (clean.length === 0) return "";
    let handle;
    try {
      handle = ctx.get("connection");
    } catch {
      return "";
    }
    if (handle === undefined || typeof handle.authenticatedUrl !== "function") return "";
    try {
      return handle.authenticatedUrl(clean);
    } catch {
      return "";
    }
  };

  /** The link the phone opens: the clean public URL plus this process's token. */
  const currentLink = () => {
    const host = tunnelHost();
    return host.length === 0 ? "" : tokenisedUrl(`https://${host}/`);
  };

  /** The durable link: stable across restarts because the code is, and it exchanges for the live token. */
  const currentEntryUrl = () => {
    const host = tunnelHost();
    return host.length === 0 || entryCode.length === 0 ? "" : `https://${host}${ENTRY_PREFIX}${entryCode}`;
  };

  const publishLink = () => {
    const link = currentEntryUrl() || currentLink();
    if (link.length === 0) return;
    if (config.printLink) {
      // Same seat as the `dsh web:` line: the terminal, never the transcript.
      console.log(`dsh opentunnel: ${link}`);
    }
    try {
      const path = linkPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${link}\n`, { mode: 0o600 });
    } catch {
      /* printing already reached the human */
    }
  };

  const start = async () => {
    if (state.phase === "connected" || state.phase === "starting") return;
    state.phase = "starting";
    state.error = "";
    try {
      const { create } = await import("@opentunnel/client");
      const port = targetPort();
      if (!Number.isInteger(port) || port <= 0) throw new Error("o listener Web ainda não tem porta; use targetPort");

      let upstreamPort = port;
      if (config.rewrite) {
        rewrite = await startRewriteProxy({
          host: config.rewriteHost,
          port: config.rewritePort,
          targetPort: port,
          entry: {
            code: () => entryCode,
            url: () => currentLink(),
          },
        });
        upstreamPort = rewrite.port;
        state.proxyPort = rewrite.port;
      }

      const api = config.api.length > 0 ? config.api : undefined;
      const proxy = config.proxy.length > 0 ? config.proxy : undefined;
      client = create({
        profile: config.profile,
        ...(api === undefined ? {} : { api }),
        ...(proxy === undefined ? {} : { proxy }),
      });

      await client.tunnel.ensure();
      if (disposed) return;
      connection = await client.tunnel.connect({
        routes: { [config.routeName]: `127.0.0.1:${upstreamPort}` },
        onEvent: (event) => {
          state.events.push(event.type);
          if (state.events.length > 40) state.events.shift();
          if (event.type === "connected") state.phase = "connected";
          if (event.type === "reconnecting" || event.type === "disconnected") state.phase = event.type;
          if (event.type === "stopped" && enabled) state.phase = "off";
        },
      });
      if (disposed || !enabled) {
        await connection.close();
        connection = undefined;
        await client?.dispose();
        client = undefined;
        await rewrite?.close();
        rewrite = undefined;
        state.phase = "off";
        return;
      }

      state.url = connection.urls[config.routeName] ?? "";
      state.host = tunnelHost();
      state.attachedAt = new Date().toISOString();
      state.phase = "connected";
      publishLink();
    } catch (error) {
      state.phase = "error";
      state.error = error instanceof Error ? error.message : String(error);
      if (config.printLink) console.error(`dsh opentunnel: ${state.error}`);
      await teardown();
      state.phase = "error";
    }
  };

  const teardown = async () => {
    try {
      await connection?.close();
    } catch {
      /* the bridge is already gone */
    }
    connection = undefined;
    try {
      await client?.dispose();
    } catch {
      /* nothing left to release */
    }
    client = undefined;
    try {
      await rewrite?.close();
    } catch {
      /* the proxy is already gone */
    }
    rewrite = undefined;
    state.url = "";
    state.host = "";
    state.proxyPort = 0;
  };

  const stop = async () => {
    state.phase = "stopping";
    await teardown();
    state.phase = "off";
  };

  /** Serialize toggles: two clicks in a row must not race on the same bridge. */
  const serialize = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const setEnabled = async (on) => {
    enabled = on;
    persist();
    if (on) {
      if (state.phase === "off" || state.phase === "error") await start();
    } else {
      await stop();
    }
    return snapshot();
  };

  const snapshot = () => ({
    enabled,
    phase: state.phase,
    url: state.url,
    host: state.host,
    routeName: config.routeName,
    rewrite: config.rewrite,
    proxyPort: state.proxyPort,
    panelPath: config.panelPath,
    linkFile: linkPath(),
    attachedAt: state.attachedAt,
    events: [...state.events],
    ...(state.error.length > 0 ? { error: state.error } : {}),
  });

  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  /** Only a page this process rendered knows the header, so the routes cannot be read cross-origin. */
  const authorised = (request) => request.headers.get(PANEL_HEADER) === token;

  const TOKEN_REFUSAL = { ok: false, error: { code: "panel-token", message: "Token da página inválido. Recarregue o DSH." } };
  const failure = (error) => ({
    ok: false,
    error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
  });

  /** A read route: the webserver answers GET and HEAD for a resource. */
  const routeGet = (suffix, handler) =>
    ctx.webServer.register({
      kind: "exact",
      path: `${config.panelPath}${suffix}`,
      resource: async (request) => {
        if (!authorised(request)) return json(TOKEN_REFUSAL, 401);
        try {
          return await handler();
        } catch (error) {
          return json(failure(error), 500);
        }
      },
    });

  /** A write route: a resource refuses non-GET, so the toggle owns the response itself. */
  const routePost = (suffix, handler) =>
    ctx.webServer.register({
      kind: "exact",
      path: `${config.panelPath}${suffix}`,
      handler: async (req, res) => {
        const send = (value, status = 200) => {
          const body = JSON.stringify(value);
          res.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
        };
        // The toggle sends no body; draining it keeps the socket reusable.
        req.resume();
        if (req.headers[PANEL_HEADER] !== token) return send(TOKEN_REFUSAL, 401);
        if (req.method !== "POST") return send({ ok: false, error: { code: "method", message: "Use POST." } }, 405);
        try {
          send(await handler());
        } catch (error) {
          send(failure(error), 500);
        }
      },
    });

  const routes = [
    routeGet("", async () => json({ ok: true, ...snapshot() })),
    routeGet("/state", async () => json({ ok: true, ...snapshot() })),
    routePost("/enable", async () => ({ ok: true, ...(await serialize(() => setEnabled(true))) })),
    routePost("/disable", async () => ({ ok: true, ...(await serialize(() => setEnabled(false))) })),
    routeGet("/link", async () => {
      const link = currentEntryUrl() || currentLink();
      if (link.length === 0) {
        return json(
          { ok: false, error: { code: "no-link", message: "O túnel ainda não anexou; tente de novo quando o estado for connected." } },
          409,
        );
      }
      return json({ ok: true, url: link, durable: link === currentEntryUrl(), host: tunnelHost() });
    }),
    routeGet("/qr", async () => {
      const link = currentEntryUrl() || currentLink();
      if (link.length === 0) {
        return json(
          { ok: false, error: { code: "no-link", message: "O túnel ainda não anexou; tente de novo quando o estado for connected." } },
          409,
        );
      }
      // The QR carries either the durable entry code or this process's token, so
      // it is rendered here, behind the panel token, and never in an <img> URL a
      // third party could log.
      return json({ ok: true, url: link, durable: link === currentEntryUrl(), svg: renderSVG(link, { ecc: "L", border: 1 }) });
    }),
  ];

  ctx.effect(() => () => {
    for (const dispose of routes) dispose();
  });

  // The page learns where the routes are and which token proves it came from
  // this process. Nothing secret is published: the token only unlocks this page.
  ctx.on("webserver/index-inject", (table) => {
    table.push({
      kind: "global",
      name: "__DSH_OPENTUNNEL__",
      value: { token, base: config.panelPath },
    });
  });

  ctx.tools.register(
    defineTool({
      name: "opentunnel",
      description:
        "Report the OpenTunnel route that exposes this DSH Web GUI over HTTPS, and its state: whether the user switched it on, the public URL, the route name, whether the loopback rewriting proxy is in front of the listener, and any failure. Use it when the user asks for the phone link, whether remote access is up, or why the tunnel stopped. Switching is the user's job: the toggle lives in Settings, and this tool is read-only. The launch token is not returned here: it lives in the DSH terminal, in the reported linkFile, and in the Settings QR code, because it grants the same access as the local session.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean", required: true },
            phase: { type: "string", required: true },
            url: { type: "string", required: true },
            host: { type: "string", required: true },
            routeName: { type: "string", required: true },
            rewrite: { type: "boolean", required: true },
            proxyPort: { type: "number", required: true },
            linkFile: { type: "string" },
            error: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `OpenTunnel ${value.enabled ? "ligado" : "desligado"} · ${value.phase}` +
              (value.url.length > 0 ? ` · ${value.url} (rota ${value.routeName})` : "") +
              `\nproxy de reescrita: ${value.rewrite ? `sim, ${value.proxyPort}` : "não"}` +
              `\nlink/QR: Configurações → OpenTunnel · arquivo: ${
                value.linkFile.length > 0 ? value.linkFile : "no terminal do DSH"
              }` +
              (value.error === undefined ? "" : `\nerro: ${value.error}`),
          },
        ],
      },
      async execute() {
        const value = snapshot();
        return {
          enabled: value.enabled,
          phase: value.phase,
          url: value.url,
          host: value.host,
          routeName: value.routeName,
          rewrite: value.rewrite,
          proxyPort: value.proxyPort,
          ...(value.linkFile.length > 0 ? { linkFile: value.linkFile } : {}),
          ...(value.error === undefined ? {} : { error: value.error }),
        };
      },
    }),
  );

  ctx.effect(() => () => {
    disposed = true;
    lifetime.abort(new Error("opentunnel plugin disposed"));
    void teardown();
  });

  const persisted = readPersisted();
  if (persisted.enabled !== undefined) enabled = persisted.enabled;
  entryCode = persisted.entryCode ?? randomBytes(16).toString("hex");
  if (persisted.entryCode === undefined) persist();
  if (enabled) void serialize(() => start());
}
