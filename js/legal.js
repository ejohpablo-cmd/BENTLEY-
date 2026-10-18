// The text of the Privacy policy and the Terms, shown in a pop-up from Settings.
// This is a plain-language template that matches how Axelvon works. Have it checked by a legal adviser
// before you publish the app to the public, and put your own contact address below.

import { el } from "./helpers.js";
import { openModal } from "./modal.js";

const CONTACT_EMAIL = "YOUR_CONTACT_EMAIL"; // replace with the address people can write to

const PRIVACY_POLICY = [
  ["What Axelvon keeps", "Your account (email, or your Google account name and email), your profile (name, username, bio, photo), your chats, the photos you send, the pictures Axelvon makes, your settings, the memories Axelvon saves when Memory is on, the feedback you send, and simple usage counters for the daily limits."],
  ["How it is used", "Only to run Axelvon for you. Your messages are sent to the AI services that write Axelvon's replies. Photos you send are described by a vision AI, and pictures are made by an image AI. Web search and the apps you connect are only used when you ask for them."],
  ["Where it is kept", "In your own protected space in the Supabase database and private file storage. Other people cannot read your chats or photos."],
  ["Sharing", "Your information is not sold. It is only passed to the services that make Axelvon work: Supabase (storage and sign in), Google (sign in with Google), and the AI, vision and picture services."],
  ["Your choices", "In Settings you can turn Memory off, clear Axelvon's memories, clear all chats and download a copy of your data. App lock keeps a PIN on this device only, to hide the app from other people who pick up your phone. To delete your account completely, contact us."],
  ["Young people", "If you are under 18, please use Axelvon with the knowledge of a parent or guardian."],
  ["Contact", `Questions about your information: ${CONTACT_EMAIL}`],
];

const TERMS = [
  ["Using Axelvon", "Axelvon is an AI companion. By using the app you agree to these terms. Use it kindly and legally: no harmful, hateful, sexual or illegal requests, and no attempts to break or misuse the service."],
  ["AI can be wrong", "Axelvon's answers and pictures are made by AI and can be mistaken or unsuitable. Check anything important yourself. Axelvon is not a doctor, lawyer or financial adviser."],
  ["Limits and rests", "To keep things fair, each cycle allows 4 pictures and 3 million tokens. When a limit is reached, Axelvon rests for 1 hour 30 minutes, then the counters start again."],
  ["Connected apps", "Axelvon asks for your approval before doing anything risky, such as sending an email. You are responsible for what you approve."],
  ["Your content", "You keep ownership of what you write and upload. You allow Axelvon to process it to give you replies. Do not upload anything you do not have the right to share."],
  ["No guarantee", "Axelvon is provided as it is, without promises that it will always be available or error free. We may change or stop parts of it, and may close accounts that break these terms."],
  ["Contact", `Questions about these terms: ${CONTACT_EMAIL}`],
];

function openLegal(title, sections) {
  const body = el("div", "legal");
  sections.forEach(([heading, text]) => {
    body.append(el("h3", undefined, heading), el("p", undefined, text));
  });
  openModal({ title, body, actions: [{ label: "Close", kind: "secondary" }] });
}

export const openPrivacyPolicy = () => openLegal("Privacy policy", PRIVACY_POLICY);
export const openTerms = () => openLegal("Terms", TERMS);
