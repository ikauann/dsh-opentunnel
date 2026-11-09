/**
 * dsh-opentunnel — Web half.
 *
 * One section inside Settings: a switch that opens or closes the public route,
 * and the QR code that carries the tokenised URL to the phone. Everything the
 * page knows comes from the Host routes under `__DSH_OPENTUNNEL__.base`, proven
 * with the token the Host injects into this document — so no other origin can
 * read the link, and the launch token never sits in a URL the browser logs.
 */
window.__ModuleLoader__.load({
  id: "@ikauann/dsh-opentunnel",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** Where the Host injected this process's route base and panel token. */
    const boot = () => globalThis.__DSH_OPENTUNNEL__ ?? {};
    const base = () => boot().base ?? "/opentunnel";

    /** One failed Host call, carrying the Host's own message. */
    class PanelError extends Error {
      constructor(message, code) {
        super(message);
        this.name = "PanelError";
        this.code = code;
      }
    }

    /** Call one Host route and unwrap `{ ok, ... }`. */
    async function call(route, options) {
      const facts = boot();
      let response;
      try {
        response = await fetch(`${facts.base ?? "/opentunnel"}${route}`, {
          method: options?.method ?? "GET",
          headers: { "x-dsh-opentunnel": facts.token ?? "" },
          cache: "no-store",
        });
      } catch (error) {
        throw new PanelError(`Falha de rede ao falar com o DSH: ${error instanceof Error ? error.message : String(error)}`, "network");
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new PanelError(body?.error?.message ?? `O DSH respondeu ${response.status}.`, body?.error?.code ?? "http");
      }
      return body;
    }

    const S = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "4px 2px 24px",
        maxWidth: "640px",
        boxSizing: "border-box",
      },
      header: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      title: { fontSize: "1.02rem", fontWeight: 600, margin: 0 },
      subtitle: {
        margin: 0,
        fontSize: "0.82rem",
        lineHeight: 1.5,
        opacity: 0.66,
      },
      pill: {
        fontSize: "0.7rem",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "3px 8px",
        borderRadius: "999px",
        border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
        opacity: 0.8,
      },
      pillOn: {
        borderColor: "color-mix(in srgb, #2f9e44 60%, transparent)",
        background: "color-mix(in srgb, #2f9e44 16%, transparent)",
        opacity: 1,
      },
      pillError: {
        borderColor: "color-mix(in srgb, #e03131 60%, transparent)",
        background: "color-mix(in srgb, #e03131 14%, transparent)",
        opacity: 1,
      },
      card: {
        border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
        borderRadius: "10px",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
      row: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
      grow: { flex: 1, minWidth: "220px" },
      label: { fontSize: "0.86rem", fontWeight: 600 },
      hint: { fontSize: "0.78rem", lineHeight: 1.5, opacity: 0.62 },
      switchTrack: {
        position: "relative",
        width: "42px",
        height: "24px",
        borderRadius: "999px",
        border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
        background: "color-mix(in srgb, currentColor 8%, transparent)",
        cursor: "pointer",
        padding: 0,
        flex: "none",
        transition: "background 120ms ease",
      },
      switchTrackOn: {
        background: "#2f9e44",
        borderColor: "#2f9e44",
      },
      switchThumb: {
        position: "absolute",
        top: "2px",
        left: "2px",
        width: "18px",
        height: "18px",
        borderRadius: "999px",
        background: "#fff",
        transition: "transform 120ms ease",
        boxShadow: "0 1px 2px rgba(0,0,0,0.28)",
      },
      switchThumbOn: { transform: "translateX(18px)" },
      qrBox: {
        width: "208px",
        height: "208px",
        borderRadius: "10px",
        background: "#fff",
        padding: "6px",
        boxSizing: "border-box",
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      mono: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "0.78rem",
        wordBreak: "break-all",
        opacity: 0.85,
      },
      button: {
        font: "inherit",
        fontSize: "0.8rem",
        color: "inherit",
        background: "color-mix(in srgb, currentColor 8%, transparent)",
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        borderRadius: "6px",
        padding: "5px 10px",
        cursor: "pointer",
        textDecoration: "none",
      },
      error: {
        fontSize: "0.8rem",
        lineHeight: 1.5,
        color: "color-mix(in srgb, #e03131 78%, currentColor)",
        borderLeft: "2px solid color-mix(in srgb, #e03131 60%, transparent)",
        paddingLeft: "8px",
      },
    };

    /** Human text for a bridge phase. */
    const phaseText = (phase, enabled) => {
      switch (phase) {
        case "connected":
          return "ligado";
        case "starting":
          return "conectando";
        case "stopping":
          return "desligando";
        case "reconnecting":
          return "reconectando";
        case "disconnected":
          return "sem conexão";
        case "error":
          return "erro";
        case "off":
          return enabled ? "aguardando" : "desligado";
        default:
          return phase ?? "—";
      }
    };

    /** The switch: a button, because a checkbox reads wrong in a settings row. */
    function Switch({ checked, disabled, onToggle }) {
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": checked ? "true" : "false",
          "aria-label": "Túnel público",
          disabled: disabled === true,
          onClick: onToggle,
          style: { ...S.switchTrack, ...(checked ? S.switchTrackOn : {}), opacity: disabled === true ? 0.55 : 1 },
        },
        h("span", { style: { ...S.switchThumb, ...(checked ? S.switchThumbOn : {}) } }),
      );
    }

    /** The Settings section: toggle, QR, link. */
    function OpenTunnelSection() {
      const [state, setState] = useState(undefined);
      const [link, setLink] = useState("");
      const [qr, setQr] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [copied, setCopied] = useState(false);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const refresh = useCallback(async () => {
        try {
          const next = await call("/state");
          if (alive.current) {
            setState(next);
            setError("");
          }
          return next;
        } catch (failure) {
          if (alive.current) setError(failure.message);
          return undefined;
        }
      }, []);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      // Poll while the bridge is in motion; the toggle returns at once and the
      // certificate can take half a minute on first use.
      useEffect(() => {
        const phase = state?.phase;
        if (phase !== "starting" && phase !== "reconnecting" && phase !== "disconnected" && phase !== "stopping") return undefined;
        const timer = setInterval(() => void refresh(), 1500);
        return () => clearInterval(timer);
      }, [state?.phase, refresh]);

      // The QR carries the launch token, so it is fetched only once the route is
      // live and re-fetched when the URL changes.
      useEffect(() => {
        if (state?.phase !== "connected") {
          setQr("");
          setLink("");
          return undefined;
        }
        let live = true;
        void (async () => {
          try {
            const answer = await call("/qr");
            if (!live) return;
            setQr(answer.svg);
            setLink(answer.url);
          } catch (failure) {
            if (live) setError(failure.message);
          }
        })();
        return () => {
          live = false;
        };
      }, [state?.phase, state?.url]);

      const toggle = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setError("");
        setCopied(false);
        try {
          const next = await call(state?.enabled === false ? "/enable" : "/disable", { method: "POST" });
          if (alive.current) setState(next);
        } catch (failure) {
          if (alive.current) {
            setError(failure.message);
            void refresh();
          }
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [busy, refresh, state?.enabled]);

      const copy = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(link);
          setCopied(true);
          setTimeout(() => {
            if (alive.current) setCopied(false);
          }, 1800);
        } catch {
          setCopied(false);
        }
      }, [link]);

      const enabled = state?.enabled !== false;
      const phase = state?.phase ?? "off";
      const pill = { ...S.pill, ...(phase === "connected" ? S.pillOn : phase === "error" ? S.pillError : {}) };

      return h(
        "div",
        { style: S.root },
        h(
          "div",
          { style: S.header },
          h("h2", { style: S.title }, "OpenTunnel"),
          h("span", { style: pill }, phaseText(phase, enabled)),
        ),
        h(
          "p",
          { style: S.subtitle },
          "Abre este GUI numa URL HTTPS pública, para usar no celular sem VPN e sem app. O listener continua só no loopback: quem chega pelo túnel passa por um proxy local que reescreve o Host.",
        ),
        h(
          "div",
          { style: S.card },
          h(
            "div",
            { style: S.row },
            h(
              "div",
              { style: S.grow },
              h("div", { style: S.label }, "Túnel público"),
              h(
                "div",
                { style: S.hint },
                enabled
                  ? "Ligado: a rota fica de pé enquanto o DSH estiver rodando."
                  : "Desligado: nenhuma rota pública é servida por este processo.",
              ),
            ),
            h(Switch, { checked: enabled, disabled: busy, onToggle: toggle }),
          ),
          state === undefined && error.length === 0 ? h("div", { style: S.hint }, "Lendo o estado…") : null,
          state?.url && phase === "connected" ? h("div", { style: S.mono }, state.url) : null,
          phase === "starting"
            ? h("div", { style: S.hint }, "Criando a rota e o certificado na primeira vez; isso leva uns 30 segundos.")
            : null,
        ),
        error.length > 0 ? h("div", { style: S.error }, error) : null,
        qr.length > 0
          ? h(
              "div",
              { style: S.card },
              h(
                "div",
                { style: S.row },
                h("div", {
                  style: S.qrBox,
                  // The markup comes from the Host's QR renderer over the
                  // token-guarded route; it is an SVG path, never user input.
                  dangerouslySetInnerHTML: { __html: qr },
                }),
                h(
                  "div",
                  { style: { ...S.grow, display: "flex", flexDirection: "column", gap: "8px" } },
                  h("div", { style: S.label }, "Escaneie com a câmera do celular"),
                  h(
                    "div",
                    { style: S.hint },
                    "O código leva o token desta sessão. Abra uma vez: o DSH troca por um cookie de 30 dias e o celular entra direto.",
                  ),
                  h(
                    "div",
                    { style: S.row },
                    h("button", { type: "button", style: S.button, onClick: copy }, copied ? "Copiado" : "Copiar link"),
                    h("a", { style: S.button, href: link, target: "_blank", rel: "noreferrer" }, "Abrir aqui"),
                  ),
                ),
              ),
            )
          : null,
        qr.length > 0
          ? h(
              "p",
              { style: S.hint },
              "Quem tiver este link tem o mesmo acesso que você nesta máquina. Para revogar, desligue o túnel ou reinicie o DSH — o token muda a cada processo.",
            )
          : null,
      );
    }

    /** Navigation mark for the section. */
    function OpenTunnelIcon({ size = 16, active = false }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          style: { opacity: active ? 1 : 0.72 },
          "aria-hidden": true,
        },
        h("rect", { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.4 }),
        h("rect", { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.4 }),
        h("rect", { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.4 }),
        h("path", { d: "M13.5 13.5h3v3h-3z" }),
        h("path", { d: "M20.5 13.5v3M17 20.5h3.5" }),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register({ name: "settings.section", id: "opentunnel", order: 60, label: "OpenTunnel" }, OpenTunnelSection),
        );
        ctx.slots.inject("settings.section.icon", () =>
          ctx.slots.register({ name: "settings.section.icon", id: "opentunnel", order: 60, label: "OpenTunnel" }, OpenTunnelIcon),
        );
      },
      /** Test seam: the components the smoke test inspects without a DOM. */
      __test: { OpenTunnelSection, OpenTunnelIcon, phaseText },
    };
  },
});
