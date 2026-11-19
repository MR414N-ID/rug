import dotenv from "dotenv";
dotenv.config();

import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PumpSdk } from "@pump-fun/pump-sdk";
import { Telegraf, Markup } from "telegraf";
import bs58 from "bs58";
import fetch from "node-fetch";
import fs from "fs";

// ============ CONFIG ============
const BOT_TOKEN       = process.env.BOT_TOKEN;
const RPC_URL         = process.env.RPC_URL;
const PRIVATE_KEY     = process.env.WALLET_PRIVATE_KEY;
const MAIN_WALLET     = process.env.MAIN_WALLET_ADDRESS || "";
const SCORE_THRESHOLD = parseInt(process.env.SCORE_THRESHOLD || "70");
const CHAT_ID         = process.env.CHAT_ID || "";
const PINATA_JWT      = process.env.PINATA_JWT || "";
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const POSITIONS_FILE  = "./positions.json";

// ============ RPC HELPERS (ANTI 429) ============
let isRpcBusy = false;
async function rpc(method, params) {
  if (isRpcBusy) await new Promise(r => setTimeout(r, 2000));
  isRpcBusy = true;
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error && json.error.code === 429) {
      console.log("⚠️ RPC 429! Istirahat 3 detik...");
      await new Promise(r => setTimeout(r, 3000));
    }
    return json.result;
  } finally {
    setTimeout(() => { isRpcBusy = false; }, 1000); // Jeda wajib 1 detik antar request
  }
}

async function getTokenSupply(mint) {
  const r = await rpc("getTokenSupply", [mint]);
  return r?.value ? parseInt(r.value.amount) : 0;
}
async function getLargestHolders(mint) {
  return (await rpc("getTokenLargestAccounts", [mint]))?.value || [];
}
async function getDevBuy(devWallet) {
  const sigs = await rpc("getSignaturesForAddress", [devWallet, { limit: 10 }]);
  if (!sigs) return 0;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
    try {
      const d = Math.abs(tx.meta.preBalances[0] - tx.meta.postBalances[0]) / 1e9;
      if (d > 0) return d;
    } catch {}
  }
  return 0;
}
async function checkSocial(uri) {
  if (!uri) return { score: 0 };
  try {
    const r = await fetch(uri, { timeout: 3000 });
    const d = await r.json();
    return { score: (d.twitter ? 15 : 0) + (d.telegram ? 15 : 0) + (d.website ? 15 : 0) };
  } catch { return { score: 0 }; }
}

// ============ ANALYZER ============
async function analyze({ mint, devWallet, metadataUri = "", mcap = 0 }) {
  const [holders, supply, devBuy, social] = await Promise.all([
    getLargestHolders(mint), getTokenSupply(mint), getDevBuy(devWallet), checkSocial(metadataUri),
  ]);
  let devHoldPct = 0, top10Pct = 0;
  if (supply > 0 && holders.length) {
    for (const h of holders) {
      const pct = parseInt(h.amount) / supply * 100;
      if (h.address === devWallet) devHoldPct = pct;
    }
    top10Pct = holders.slice(0, 10).reduce((a, h) => a + parseInt(h.amount), 0) / supply * 100;
  }
  const scores = {
    dev_hold: { value: +devHoldPct.toFixed(2), score: devHoldPct < 5 ? 100 : devHoldPct < 10 ? 70 : devHoldPct < 15 ? 40 : 0 },
    top10:    { value: +top10Pct.toFixed(2),  score: top10Pct < 40 ? 100 : top10Pct < 60 ? 70 : top10Pct < 75 ? 40 : 0 },
    dev_buy:  { value: +devBuy.toFixed(3),    score: devBuy >= 0.05 && devBuy <= 0.5 ? 100 : devBuy < 1 ? 70 : devBuy < 2 ? 30 : 0 },
    social:   { value: social,                 score: social.score },
    mcap:     { value: Math.round(mcap),       score: mcap >= 4000 && mcap <= 8000 ? 100 : mcap < 15000 ? 60 : mcap < 30000 ? 20 : 0 },
  };
  const w = { dev_hold: 0.25, top10: 0.25, dev_buy: 0.20, social: 0.15, mcap: 0.15 };
  const total = Object.keys(scores).reduce((a, k) => a + scores[k].score * w[k], 0);
  return { mint, score: +total.toFixed(1), verdict: total >= 70 ? "SNIPE" : total >= 50 ? "WATCH" : "SKIP" };
}

// ============ TRADER ============
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const sdk = new PumpSdk(connection);

async function getBalance() {
  return (await connection.getBalance(wallet.publicKey)) / 1e9;
}

async function sendIx(instructions, extraSigners = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet, ...extraSigners]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function buy(mintStr, solAmount) {
  const mint = new PublicKey(mintStr);
  const lamports = Math.floor(solAmount * 1e9);
  const state = await sdk.fetchBuyState(mint, wallet.publicKey);
  const ix = await sdk.buyInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: wallet.publicKey,
    solAmount: BigInt(lamports), amount: BigInt(Math.floor(lamports * 1.1)), slippage: 0.15,
  });
  return sendIx(ix);
}

async function sellAll(mintStr) {
  const mint = new PublicKey(mintStr);
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const info = await connection.getTokenAccountBalance(ata);
  const raw = BigInt(info.value.amount);
  if (raw === 0n) throw new Error("no token balance");
  const state = await sdk.fetchSellState(mint, wallet.publicKey);
  const ix = await sdk.sellInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: wallet.publicKey,
    amount: raw, slippage: 0.20,
  });
  return sendIx(ix);
}

async function getTokenHoldings() {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  const holdings = [];
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    if (info.tokenAmount.uiAmount > 0) holdings.push({ mint: info.mint, amount: info.tokenAmount.uiAmount, raw: info.tokenAmount.amount });
  }
  return holdings;
}

// ============ HARD MODE STATE ============
let POSITIONS = {};
if (fs.existsSync(POSITIONS_FILE)) { try { POSITIONS = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8")); } catch {} }
function savePositions() { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(POSITIONS, null, 2)); }

const hardMode = {
  active: false,
  initialBalance: 0,
  dailyPnL: 0,
  maxLossLimit: 0.5, // 50% dari modal
  buyAmountPerCoin: 0.0066, // ~$1 per koin
  maxCoins: 5, // Maksimal pegang 5 koin sekaligus
  sweepThreshold: 0.02, // Kirim profit ke wallet utama kalau udah numpuk 0.02 SOL
};

async function getCurrentPrice(mintStr) {
  try {
    const pData = await sdk.fetchBuyState(new PublicKey(mintStr), wallet.publicKey);
    return parseFloat(pData.bondingCurve.virtualSolReserves.toString()) / parseFloat(pData.bondingCurve.virtualTokenReserves.toString());
  } catch { return 0; }
}

// ============ AUTO TP/SL (DYNAMIC TRAILING) ============
async function hardModeLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, 15000)); // Cek tiap 15 detik (Hemat RPC)
    if (!hardMode.active) continue;

    const mints = Object.keys(POSITIONS);
    for (const mint of mints) {
      try {
        const pnl = await getPnl(mint);
        if (!pnl) continue;

        const pos = POSITIONS[mint];
        if (!pos.peakPnlPct || pnl.pnlPct > pos.peakPnlPct) { pos.peakPnlPct = pnl.pnlPct; savePositions(); }

        let reason = null;
        // Dynamic Trailing Stop Logic
        let currentTrail = 0;
        if (pos.peakPnlPct >= 100) currentTrail = 25;
        else if (pos.peakPnlPct >= 80) currentTrail = 20;
        else if (pos.peakPnlPct >= 60) currentTrail = 15;
        else if (pos.peakPnlPct >= 40) currentTrail = 10;
        else if (pos.peakPnlPct >= 20) currentTrail = 5;

        if (pnl.pnlPct <= -20) reason = "CUT LOSS";
        else if (currentTrail > 0 && pnl.pnlPct <= (pos.peakPnlPct - currentTrail)) reason = "TRAILING";
        else if (pnl.pnlPct >= 50) reason = "TP FAST"; // Jual cepet kalau untung 50% (opsional)

        if (reason) {
          console.log(`[HARD-${reason}] ${mint} ${pnl.pnlPct}%`);
          const sig = await sellAll(mint);
          
          // Hitung untung/rugi bersih ke SOL
          const profitSol = pnl.pnlSol;
          hardMode.dailyPnL += profitSol;
          
          delete POSITIONS[mint];
          savePositions();
          
          if (CHAT_ID) {
            const emoji = profitSol >= 0 ? "🟢" : "🔴";
            await bot.telegram.sendMessage(CHAT_ID, `${emoji} *HARD ${reason}* ${mint.slice(0, 8)}\nPnL: ${pnl.pnlPct}% (${profitSol.toFixed(4)} SOL)\ntx: \`${sig}\``, { parse_mode: "Markdown" });
          }

          // Sweep profit ke main wallet
          if (MAIN_WALLET && profitSol > 0 && profitSol >= hardMode.sweepThreshold) {
            try {
              const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(MAIN_WALLET), lamports: Math.floor(profitSol * 0.8 * LAMPORTS_PER_SOL) });
              await sendIx([ix]);
              if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, `💸 *SWEEP* Profit ${(profitSol * 0.8).toFixed(4)} SOL dikirim ke wallet utama.`, { parse_mode: "Markdown" });
            } catch (e) { console.error("Sweep error:", e.message); }
          }
        }
      } catch (e) { console.error(`[hard-loop] ${mint} err: ${e.message}`); }
    }
  }
}

async function getPnl(mint) {
  const pos = POSITIONS[mint];
  if (!pos) return null;
  const current = await getCurrentPrice(mint);
  if (!current || !pos.entryPrice) return null;
  const currentValueSol = current * pos.tokenAmount;
  const pnlSol = currentValueSol - pos.entrySol;
  return { pnlSol: +pnlSol.toFixed(4), pnlPct: +((pnlSol / pos.entrySol) * 100).toFixed(1) };
}

// ============ DASHBOARD 3 MENIT ============
setInterval(async () => {
  if (!hardMode.active || !CHAT_ID) return;
  try {
    const bal = await getBalance();
    const holdings = await getTokenHoldings();
    let report = `📊 *HARD MODE STATUS*\n\n`;
    report += `Saldo Bot: *${bal.toFixed(4)} SOL*\n`;
    report += `Total PnL Hari Ini: *${hardMode.dailyPnL > 0 ? "+" : ""}${hardMode.dailyPnL.toFixed(4)} SOL*\n\n`;
    
    if (holdings.length === 0) report += `_(Lagi nyari koin baru...)_\n`;
    else {
      report += `*Posisi Aktif:*\n`;
      for (const h of holdings) {
        const pnl = await getPnl(h.mint);
        report += pnl ? `- \`${h.mint.slice(0,6)}\` : ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%\n` : `- \`${h.mint.slice(0,6)}\`\n`;
      }
    }
    
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔴 STOP PANIC", "hard_stop")],
      [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
    ]);
    await bot.telegram.sendMessage(CHAT_ID, report, { parse_mode: "Markdown", ...kb });
  } catch (e) {}
}, 180000); // 3 Menit

// ============ AUTO MONITOR & SEBAR ============
connection.onLogs(new PublicKey(PUMP_PROGRAM_ID), async ({ logs, signature }) => {
  try {
    if (!hardMode.active) return;
    if (!logs.some((l) => l.includes("Instruction: Create"))) return;
    
    const holdings = await getTokenHoldings();
    if (holdings.length >= hardMode.maxCoins) return; // Jangan beli kalau udah penuh

    const bal = await getBalance();
    if (bal <= hardMode.initialBalance * hardMode.maxLossLimit) {
      hardMode.active = false;
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, `🚨 *CIRCUIT BREAKER* 🚨\nSaldo turun 50%! Hard Mode dimatikan otomatis buat nyimpen sisa duit lo.`, { parse_mode: "Markdown" });
      return;
    }

    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
    const mint = (tx?.meta?.postTokenBalances || [])[0]?.mint;
    if (!mint) return;
    
    const res = await analyze({ mint, devWallet: tx.transaction.message.accountKeys[0]?.toString() });
    if (res.score >= SCORE_THRESHOLD) {
       // BELI!
       const sig = await buy(mint, hardMode.buyAmountPerCoin);
       const price = await getCurrentPrice(mint);
       POSITIONS[mint] = { entrySol: hardMode.buyAmountPerCoin, entryPrice: price, tokenAmount: hardMode.buyAmountPerCoin / price, peakPnlPct: 0, tx: sig };
       savePositions();
       if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, `🔥 *HARD BUY* 🔥\n\`${mint.slice(0,8)}\` | Skor: ${res.score}\ntx: \`${sig}\``, { parse_mode: "Markdown" });
    }
  } catch (e) { }
}, "confirmed");

// ============ BOT UI ============
const bot = new Telegraf(BOT_TOKEN);
const SESSIONS = {};

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎯 SNIPE (Manual)", "list_snipe")],
    [Markup.button.callback("🚀 LAUNCH", "launch")],
    [Markup.button.callback("💼 HOLDINGS (PnL)", "holdings")],
    [Markup.button.callback("⚙️ AUTO TP/SL NORMAL", "auto_menu")],
    [Markup.button.callback("🔥 HARD MODE MENU 🔥", "hard_menu")],
    [Markup.button.callback("📊 WALLET & WITHDRAW", "wallet")],
  ]);
}

bot.start((ctx) => ctx.reply("🤖 *Pump Bot Pro*", { parse_mode: "Markdown", ...menu() }));
bot.action("menu", (ctx) => ctx.editMessageText("🤖 *Pump Bot Pro*", { parse_mode: "Markdown", ...menu() }));

bot.action("hard_menu", (ctx) => {
  const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
  return ctx.editMessageText(
    `🔥 *HARD MODE SETTINGS* 🔥\n\n` +
    `Status: ${status}\n` +
    `Modal Awal: ${hardMode.initialBalance.toFixed(3)} SOL\n` +
    `Jatah per Koin: ${hardMode.buyAmountPerCoin} SOL\n` +
    `Max Koin: ${hardMode.maxCoins}\n` +
    `Circuit Breaker: -50%`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(hardMode.active ? "🔴 STOP HARD MODE" : "🟢 START HARD MODE", "hard_toggle")],
        [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
        [Markup.button.callback("⬅️ menu", "menu")],
      ]),
    }
  );
});

bot.action("hard_toggle", async (ctx) => {
  if (!hardMode.active) {
    hardMode.initialBalance = await getBalance();
    hardMode.dailyPnL = 0;
    hardMode.active = true;
    await ctx.answerCbQuery("Hard Mode ON!");
  } else {
    hardMode.active = false;
    await ctx.answerCbQuery("Hard Mode OFF!");
  }
  ctx.editMessageText(`Hard Mode sekarang: ${hardMode.active ? "🟢 AKTIF" : "🔴 MATI"}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "hard_menu")]]));
});

bot.action("hard_stop", async (ctx) => { hardMode.active = false; await ctx.answerCbQuery("PANIC STOP DITEKAN!"); });

bot.action("hard_sellall", async (ctx) => {
  await ctx.answerCbQuery("Jual semua...");
  const holdings = await getTokenHoldings();
  for (const h of holdings) {
    try { await sellAll(h.mint); delete POSITIONS[h.mint]; } catch (e) {}
  }
  savePositions();
  ctx.reply("✅ Semua koin berhasil dijual (SELL ALL).");
});

// --- SNIPER MANUAL ---
bot.action(/^snipe_(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  await ctx.editMessageText(`⏳ beli...`);
  try {
    const sig = await buy(mint, hardMode.buyAmountPerCoin);
    const price = await getCurrentPrice(mint);
    POSITIONS[mint] = { entrySol: hardMode.buyAmountPerCoin, entryPrice: price, tokenAmount: hardMode.buyAmountPerCoin / price, peakPnlPct: 0, tx: sig };
    savePositions();
    ctx.editMessageText(`✅ entry! tx: ${sig}`);
  } catch (e) { ctx.editMessageText(`❌ gagal: ${e.message}`); }
});

bot.action(/^sellall_(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  await ctx.editMessageText(`⏳ jual...`);
  try { await sellAll(mint); delete POSITIONS[mint]; savePositions(); ctx.editMessageText(`✅ sold 100%`); } catch (e) { ctx.editMessageText(`❌ gagal: ${e.message}`); }
});

bot.action("holdings", async (ctx) => {
  const holdings = await getTokenHoldings();
  let text = "💼 *HOLDINGS*\n\n"; const btns = [];
  for (const h of holdings) {
    const pnl = await getPnl(h.mint);
    text += pnl ? `- \`${h.mint.slice(0,6)}\` : ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%\n` : `- \`${h.mint.slice(0,6)}\`\n`;
    btns.push([Markup.button.callback(`🔴 SELL ${h.mint.slice(0,6)}`, `sellall_${h.mint}`)]);
  }
  btns.push([Markup.button.callback("⬅️ menu", "menu")]);
  ctx.editMessageText(text || "Kosong", { parse_mode: "Markdown", ...Markup.inlineKeyboard(btns) });
});

bot.action("wallet", async (ctx) => {
  const bal = await getBalance();
  ctx.editMessageText(`📊 *WALLET*\nSOL: *${bal.toFixed(4)}*\naddr: \`${wallet.publicKey.toBase58()}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]) });
});

// --- LAUNCH & AUTO MENU (Disederhanakan karena fokus ke Hard Mode) ---
bot.action("launch", (ctx) => { ctx.editMessageText("Fitur Launch ikut kode sebelumnya ya he, ini fokus Hard Mode."); });
bot.action("auto_menu", (ctx) => { ctx.editMessageText("Menu Auto TP/SL normal digabung ke Hard Mode ya he."); });

hardModeLoop();
bot.launch();
console.log("🔥 HARD MODE BOT RUNNING 🔥");
