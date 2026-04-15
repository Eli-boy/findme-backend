import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "url";
import { generateQRCode } from "./src/utils/generateQR.js";
import path from "path";
import scanRoutes from "./src/routes/scan.js";
import { supabase } from "./src/services/supabase.js";
import twilio from "twilio";

dotenv.config();

console.log("🔥 NEW DEPLOY TEST");

const app = express();

// ===============================
// 🛡️ SAFE TWILIO INIT
// ===============================
let client;
try {
  if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH) {
    throw new Error("TWILIO_SID or TWILIO_AUTH is missing");
  }
  client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
  console.log("✅ Twilio initialized");
} catch (err) {
  console.error("❌ Twilio init failed:", err.message);
  console.error("⚠️  WhatsApp messaging will be disabled until env vars are set.");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// STATIC
app.use("/logo", express.static("logo"));

// ROUTES
app.use("/scan", scanRoutes);

const ADMIN_SECRET = process.env.ADMIN_SECRET || "findme_dev_123";

app.get("/", (req, res) => {
  res.status(200).send("FindMe API is Live 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ===============================
// 🤖 WHATSAPP WEBHOOK
// ===============================
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log("BODY:", req.body);

  res.status(200).send("OK");

  const { Body: text, From: senderPhone } = req.body;
  if (!senderPhone) return;

  let cleanPhone = senderPhone.replace("whatsapp:", "").replace("+", "");

  if (cleanPhone.startsWith("0")) {
    cleanPhone = "234" + cleanPhone.slice(1);
  }

  const message = text?.trim() || "";
  const now = new Date();

  try {
    console.log(`[Webhook] ${cleanPhone}: ${message}`);

    // ===============================
    // 1. LINK START
    // ===============================
    if (message.toUpperCase().startsWith("LINK_")) {
      const code = message.replace(/LINK_/i, "").trim();

      const { data: qr } = await supabase
        .from("qr_codes")
        .select("*")
        .eq("code", code)
        .maybeSingle();

      if (!qr) {
        return sendMessage(cleanPhone, "❌ Invalid QR code.");
      }

      await supabase
        .from("qr_codes")
        .update({
          owner_phone: cleanPhone,
          is_linked: false,
        })
        .eq("code", code);

      return sendMessage(
        cleanPhone,
        `👋 Welcome to *FindMe!*\n\nWhat is the name of your item?`
      );
    }

    // ===============================
    // 2. SAVE ITEM NAME
    // ===============================
    const { data: pendingQR } = await supabase
      .from("qr_codes")
      .select("*")
      .eq("owner_phone", cleanPhone)
      .eq("is_linked", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingQR && !message.toUpperCase().startsWith("FOUND_")) {
      await supabase
        .from("qr_codes")
        .update({ is_linked: true })
        .eq("id", pendingQR.id);

      await supabase.from("items").insert({
        qr_id: pendingQR.id,
        item_name: message,
        description: "protected",
      });

      return sendMessage(
        cleanPhone,
        `✅ *${message}* linked successfully!`
      );
    }

    // ===============================
    // 3. ITEM FOUND FLOW
    // ===============================
    if (message.toUpperCase().startsWith("FOUND_")) {
      const code = message.split("_")[1]?.trim();

      const { data: qr } = await supabase
        .from("qr_codes")
        .select("*")
        .eq("code", code)
        .maybeSingle();

      if (!qr) {
        return sendMessage(cleanPhone, "❌ Invalid code.");
      }

      if (!qr.is_linked) {
        return sendMessage(cleanPhone, "⚠️ Not activated yet.");
      }

      let itemName = "item";

      const { data: item } = await supabase
        .from("items")
        .select("item_name")
        .eq("qr_id", qr.id)
        .maybeSingle();

      if (item?.item_name) itemName = item.item_name;

      const expiry = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      await supabase.from("chat_sessions").insert({
        qr_id: qr.id,
        owner_phone: qr.owner_phone,
        founder_phone: cleanPhone,
        expires_at: expiry.toISOString(),
      });

      await sendMessage(
        qr.owner_phone,
        `🚨 Someone found your *${itemName}*!`
      );

      return sendMessage(
        cleanPhone,
        `✅ Owner notified! You can chat here.`
      );
    }

    // ===============================
    // 4. CHAT RELAY
    // ===============================
    const { data: sessions } = await supabase
      .from("chat_sessions")
      .select("*")
      .gt("expires_at", new Date().toISOString());

    const session = sessions?.find(
      (s) =>
        String(s.founder_phone) === cleanPhone ||
        String(s.owner_phone) === cleanPhone
    );

    if (session) {
      const isOwner = cleanPhone === session.owner_phone;

      const recipient = isOwner
        ? session.founder_phone
        : session.owner_phone;

      await sendMessage(
        recipient,
        `${isOwner ? "👤 Owner" : "🔎 Finder"}: ${message}`
      );

      return;
    }

    // ===============================
    // DEFAULT
    // ===============================
    await sendMessage(cleanPhone, "🤖 Invalid command.");

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});


// ===============================
app.get("/generate", async (req, res) => {
  if (req.query.api_key !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json(await generateQRCode());
});


// ===============================
async function sendMessage(to, text) {
  if (!client) {
    console.error("❌ Twilio client not initialized. Cannot send message to:", to);
    return;
  }
  try {
    await client.messages.create({
      from: `whatsapp:${process.env.WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: text,
    });
  } catch (error) {
    console.error("❌ Twilio error:", error);
  }
}


// ===============================
const PORT = process.env.PORT || 3000;

console.log("🚀 Starting server...");
console.log("PORT:", PORT);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
