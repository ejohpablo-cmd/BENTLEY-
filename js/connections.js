// Connected apps: loading them, connecting Google (sign-in page) and GitHub, Supabase and Composio (a token),
// disconnecting, and the message shown when Google sends you back.

import { state } from "./state.js";
import { supabase, startGoogleConnect, disconnectGoogle, saveConnectionToken, disconnectProvider } from "./api.js";
import { el, toast } from "./helpers.js";
import { confirmDialog, openModal } from "./modal.js";

export async function loadConnections() {
  const { data, error } = await supabase
    .from("connections")
    .select("provider,account_email")
    .eq("user_id", state.user.id);
  if (error) {
    console.error(error); // the rest of the app works without this list
    return;
  }
  state.connections = data || [];
}

export function getConnection(provider) {
  return state.connections.find((connection) => connection.provider === provider) || null;
}

// Sends the person to Google's sign-in page. Returns false if that could not be started.
export async function connectGoogle() {
  try {
    window.location.href = await startGoogleConnect();
    return true;
  } catch (error) {
    console.error(error);
    toast("Couldn't start the Google sign-in. Please try again.");
    return false;
  }
}

export function openDisconnectGoogle(onDone) {
  confirmDialog({
    title: "Disconnect Google?",
    message: "Bentley will no longer be able to use your Gmail, Calendar or Drive. You can connect again any time.",
    confirmLabel: "Disconnect",
    onConfirm: async () => {
      try {
        await disconnectGoogle();
      } catch (error) {
        console.error(error);
        toast("Couldn't disconnect. Please try again.");
        return false;
      }
      state.connections = state.connections.filter((connection) => connection.provider !== "google");
      onDone();
      toast("Google disconnected");
      return true;
    },
  });
}

/* ---------- GitHub, Supabase and Composio: connect with a token ---------- */

const TOKEN_PROVIDERS = {
  github: {
    name: "GitHub",
    placeholder: "github_pat_…",
    help: "Create a personal access token on GitHub (Settings → Developer settings → Personal access tokens). Choose the repositories Bentley may use and give it read and write access to Contents, Issues and Pull requests.",
    removes: "read or change your GitHub repositories",
  },
  supabase: {
    name: "Supabase",
    placeholder: "sbp_…",
    help: "Create an access token at supabase.com/dashboard/account/tokens and paste it here. It lets Bentley reach all of your Supabase projects, and she asks you before running any SQL.",
    removes: "reach your Supabase projects",
  },
  composio: {
    name: "Composio",
    placeholder: "Your Composio API key",
    help: "Copy your API key from your Composio dashboard. Connect your apps inside Composio first, then Bentley can use them.",
    removes: "use your Composio apps",
  },
};

// Opens the pop-up where the person pastes their token. onDone runs after it has been saved.
export function openConnectToken(provider, onDone) {
  const details = TOKEN_PROVIDERS[provider];

  const form = el("form", "modal-form");
  form.addEventListener("submit", (event) => event.preventDefault());

  const label = el("label", "field");
  label.append(el("span", undefined, `${details.name} token`));
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 500;
  input.placeholder = details.placeholder;
  label.append(input);

  const message = el("p", "form-error");
  form.append(el("p", "modal-text", details.help), label, message);

  openModal({
    title: `Connect ${details.name}`,
    body: form,
    actions: [
      {
        label: "Connect",
        kind: "primary",
        onClick: async () => {
          const token = input.value.trim();
          if (!token) {
            message.textContent = "Paste your token first.";
            return false;
          }
          try {
            const result = await saveConnectionToken(provider, token);
            if (!result.ok) {
              message.textContent = result.error || "That token was not accepted.";
              return false;
            }
            state.connections = [
              ...state.connections.filter((connection) => connection.provider !== provider),
              { provider, account_email: result.label },
            ];
          } catch (error) {
            console.error(error);
            message.textContent = "Couldn't connect. Please try again.";
            return false;
          }
          onDone();
          toast(`${details.name} connected`);
          return true;
        },
      },
      { label: "Cancel", kind: "secondary" },
    ],
  });
  input.focus();
}

export function openDisconnectToken(provider, onDone) {
  const details = TOKEN_PROVIDERS[provider];
  confirmDialog({
    title: `Disconnect ${details.name}?`,
    message: `Bentley will no longer be able to ${details.removes}. You can connect again any time.`,
    confirmLabel: "Disconnect",
    onConfirm: async () => {
      try {
        await disconnectProvider(provider);
      } catch (error) {
        console.error(error);
        toast("Couldn't disconnect. Please try again.");
        return false;
      }
      state.connections = state.connections.filter((connection) => connection.provider !== provider);
      onDone();
      toast(`${details.name} disconnected`);
      return true;
    },
  });
}

const CONNECT_ERRORS = {
  cancelled: "Google connection cancelled.",
  permissions: "Bentley needs every permission ticked to work. Please try again.",
  failed: "Couldn't connect Google. Please try again.",
};

// When Google sends the person back, the address says how it went. Shows it once and tidies the address.
// Returns true if there was a result to show.
export function announceConnectionResult() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  const problem = params.get("connect_error");
  if (!connected && !problem) return false;

  params.delete("connected");
  params.delete("connect_error");
  const query = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);

  if (connected === "google") toast("Google connected");
  else toast(CONNECT_ERRORS[problem] || CONNECT_ERRORS.failed);
  return true;
}
