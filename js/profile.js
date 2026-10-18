// The Profile page: your details, one profile photo, and Bentley's card.

import { state } from "./state.js";
import { supabase, uploadProfilePhoto } from "./api.js";
import { $, el, toast } from "./helpers.js";
import { openModal } from "./modal.js";
import { buildBentleyAvatar, buildUserAvatar } from "./avatars.js";
import { onPageShown } from "./navigation.js";

/* ---------- Loading ---------- */

export async function loadProfile() {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", state.user.id).maybeSingle();
  if (error) throw error;
  if (data) {
    state.profile = data;
    return;
  }

  // First visit: create the profile from the email name.
  const emailName = (state.user.email || "user").split("@")[0];
  const base = emailName.replace(/[^a-z0-9_]/gi, "").toLowerCase().slice(0, 16) || "user";
  const created = await supabase
    .from("profiles")
    .insert({ id: state.user.id, username: `${base}_${state.user.id.slice(0, 6)}`, display_name: base })
    .select("*")
    .single();
  if (created.error) throw created.error;
  state.profile = created.data;
}

async function loadStats() {
  const conversationsBox = $("#stat-conversations");
  const messagesBox = $("#stat-messages");
  if (!conversationsBox || !messagesBox || !state.user) return;

  try {
    const [conversations, messages] = await Promise.all([
      supabase.from("conversations").select("id", { count: "exact", head: true }).eq("user_id", state.user.id),
      supabase.from("messages").select("id", { count: "exact", head: true }).eq("user_id", state.user.id).eq("role", "user"),
    ]);
    conversationsBox.textContent = String(conversations.count ?? 0);
    messagesBox.textContent = String(messages.count ?? 0);
  } catch (error) {
    console.error(error);
  }
}

/* ---------- Drawing the page ---------- */

function buildStat(id, label) {
  const stat = el("div", "stat");
  const number = el("strong", undefined, "–");
  number.id = id;
  stat.append(number, el("span", undefined, label));
  return stat;
}

function buildProfileCard(profile) {
  const card = el("section", "profile-card");
  card.append(
    buildUserAvatar("lg"),
    el("h2", "profile-name", profile.display_name || "Bentley User"),
    el("p", "profile-username", `@${profile.username || "user"}`)
  );
  if (profile.bio) card.append(el("p", "profile-bio", profile.bio));

  const edit = el("button", "btn secondary sm", "Edit profile");
  edit.type = "button";
  edit.addEventListener("click", openEditProfile);
  card.append(edit);

  const stats = el("div", "stats");
  stats.append(buildStat("stat-conversations", "Conversations"), buildStat("stat-messages", "Messages sent"));
  card.append(stats);
  return card;
}

function buildBentleyCard() {
  const card = el("section", "bentley-card");

  const info = el("div");
  const status = el("p", "status");
  status.append(el("span", "status-dot"), document.createTextNode("Online"));
  info.append(el("h2", undefined, "Bentley"), el("p", undefined, "AI Creative Companion"), status);

  card.append(buildBentleyAvatar("md"), info);
  return card;
}

function buildSignOutButton() {
  const button = el("button", "btn secondary", "Sign out");
  button.type = "button";
  button.addEventListener("click", async () => {
    const { error } = await supabase.auth.signOut();
    if (error) toast("Couldn't sign out. Please try again.");
  });
  return button;
}

export function renderProfile() {
  const root = $("#profile-root");
  root.replaceChildren(buildProfileCard(state.profile || {}), buildBentleyCard(), buildSignOutButton());
}

/* ---------- Profile photo ---------- */

// Shrinks the chosen photo to at most 512px and turns it into a small JPEG.
async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The image could not be processed."))),
      "image/jpeg",
      0.85
    );
  });
}

/* ---------- Edit profile ---------- */

function buildField(labelText, value, { maxLength, multiline = false }) {
  const label = el("label", "field");
  label.append(el("span", undefined, labelText));

  const input = document.createElement(multiline ? "textarea" : "input");
  if (!multiline) input.type = "text";
  input.maxLength = maxLength;
  input.value = value || "";
  label.append(input);
  return { label, input };
}

// One round preview and one "Change photo" button. Only a single image can be chosen.
function buildPhotoPicker(onPick) {
  const picker = el("div", "photo-picker");
  const preview = el("div", "photo-preview");
  preview.append(buildUserAvatar("lg"));

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;

  const choose = el("button", "btn secondary sm", "Change photo");
  choose.type = "button";
  choose.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    preview.replaceChildren(buildUserAvatar("lg", URL.createObjectURL(file)));
    onPick(file);
  });

  picker.append(preview, choose, fileInput);
  return picker;
}

function openEditProfile() {
  const profile = state.profile || {};
  let chosenPhoto = null;

  const form = el("form", "modal-form");
  form.addEventListener("submit", (event) => event.preventDefault());

  const photo = buildPhotoPicker((file) => {
    chosenPhoto = file;
  });
  const displayName = buildField("Display name", profile.display_name, { maxLength: 50 });
  const username = buildField("Username", profile.username, { maxLength: 24 });
  const bio = buildField("Bio", profile.bio, { maxLength: 160, multiline: true });
  const message = el("p", "form-error");
  form.append(photo, displayName.label, username.label, bio.label, message);

  openModal({
    title: "Edit profile",
    body: form,
    actions: [
      {
        label: "Save",
        kind: "primary",
        onClick: async () => {
          const values = {
            display_name: displayName.input.value.trim(),
            username: username.input.value.trim().toLowerCase(),
            bio: bio.input.value.trim(),
          };

          if (values.display_name.length < 1 || values.display_name.length > 50) {
            message.textContent = "Display name must be 1–50 characters.";
            return false;
          }
          if (!/^[a-z0-9_]{3,24}$/.test(values.username)) {
            message.textContent = "Username: 3–24 characters, lowercase letters, numbers or underscores.";
            return false;
          }

          try {
            if (chosenPhoto) {
              if (!chosenPhoto.type.startsWith("image/")) {
                message.textContent = "Please choose an image file.";
                return false;
              }
              values.avatar_url = await uploadProfilePhoto(state.user.id, await shrinkPhoto(chosenPhoto));
            }

            const { data, error } = await supabase
              .from("profiles")
              .update(values)
              .eq("id", state.user.id)
              .select("*")
              .single();
            if (error) throw error;

            state.profile = data;
          } catch (error) {
            console.error(error);
            message.textContent =
              error && error.code === "23505"
                ? "That username is taken."
                : "Couldn't save your profile. Try a JPG or PNG photo, or try again.";
            return false;
          }

          renderProfile();
          loadStats();
          toast("Profile updated");
          return true;
        },
      },
      { label: "Cancel", kind: "secondary" },
    ],
  });
}

export function bindProfile() {
  onPageShown("profile", loadStats);
}
