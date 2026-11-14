import {requireAdminSession, signOutUser, callFunction} from "../assets/firebase-client.js?v=5";

// Owner's switch for the 7 warm servers (serverWarmth callable, owner claim only).

const NAMES = {
  createorder: "Place order",
  getcheckoutconfiguration: "Checkout prices",
  updateorderstatus: "Order status",
  onordercreated: "New order alert",
  onorderupdated: "Order changes",
  ondispatchclaimwritten: "Delivery partner claim",
  ontrackingupdated: "Live tracking",
};

function toast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast " + (kind || "");
  node.textContent = message;
  document.getElementById("toast-stack").appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function render(data) {
  const state = document.getElementById("state");
  state.innerHTML = {
    always: "Now: <strong>24/7</strong>, warm day and night",
    schedule: "Now: <strong>7 AM–midnight</strong>, cold overnight",
    cold: "Now: <strong>Off</strong>, all cold",
  }[data.mode] || "Now: <strong>Mixed</strong>, tap one to set all the same";
  for (const b of document.querySelectorAll("#modes [data-mode]")) {
    const on = b.dataset.mode === data.mode;
    b.className = "btn " + (on ? "btn-primary" : "btn-secondary");
    b.setAttribute("aria-pressed", String(on));
  }
  document.getElementById("list").innerHTML = (data.servers || []).map((s) =>
    "<li><span>" + (NAMES[s.service] || s.service) + "</span><span class=\"" + (s.warmNow ? "on" : "off") + "\">" +
    (s.warmNow ? "Warm" : "Cold") + "</span></li>").join("");
}

function busy(on, label) {
  for (const b of document.querySelectorAll("#modes [data-mode]")) b.disabled = on;
  if (on) document.getElementById("state").textContent = label;
}

async function load() {
  try {
    render(await callFunction("serverWarmth", {}));
  } catch (error) {
    document.getElementById("state").textContent = error.message;
  }
}

async function switchTo(mode) {
  busy(true, "Switching… about 15 seconds");
  try {
    render(await callFunction("serverWarmth", {mode}));
    toast({always: "Servers warm 24/7.", schedule: "Servers warm 7 AM–midnight.", cold: "All servers are off (cold)."}[mode], "success");
  } catch (error) {
    toast(error.message, "danger");
    await load();
  } finally {
    busy(false);
  }
}

const session = await requireAdminSession();
if (session) {
  document.getElementById("app-shell").hidden = false;
  const who = document.getElementById("sidebar-who");
  if (who && session.user) who.textContent = session.user.email || "";
  document.getElementById("signout-btn").addEventListener("click", async () => {
    await signOutUser();
    window.location.replace("../");
  });
  for (const b of document.querySelectorAll("#modes [data-mode]")) b.addEventListener("click", () => switchTo(b.dataset.mode));
  load();
}
