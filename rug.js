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
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const POSITIONS_FILE  = "./positions.json";

// Gambar tema candlestick hijau trading
const WELCOME_IMG = "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?q=80&w=1000&auto=format&fit=crop";

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
      await new Promise(r => setTimeout(r, 3000));
    }
    return json.result;
  } finally {
    setTimeout(() => { isRpcBusy = false; }, 1000);
  }
}

async function getTokenSupply(mint) {
  const r = await rpc("getTokenSupply", [mint]);
  return r?.value ? parseInt(r.value.amount) : 0;
}
async function getLargestHolders(mint) {
  return (await rpc("getTokenLargestAccounts", [mint]))?.value || [];
}

// ============ ANALYZER ============
async function analyze({ mint, devWallet }) {
  try {
    const holders = await getLargestHolders(mint);
    const supply = await getTokenSupply(mint);
    let devHoldPct = 0, top10Pct = 0;
    
    if (supply > 0 && holders.length) {
      for (const h of holders) {
        const pct = parseInt(h.amount) / supply * 100;
        if (h.address === devWallet) devHoldPct = pct;
      }
      top10Pct = holders.slice(0, 10).reduce((a, h) => a + parseInt(h.amount), 0) / supply * 100;
    }
    
    let volumeScore = 0;
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const dexData = await dexRes.json();
      if (dexData.pairs && dexData.pairs.length > 0) {
         const pair = dexData.pairs[0];
         const vol5m = parseFloat(pair.volume?.m5 || "0");
         if (vol5m > 1000) volumeScore = 100;
         else if (vol5m > 100) volumeScore = 50;
      }
    } catch(e) {}

    const scores = {
      dev_hold: devHoldPct < 5 ? 100 : devHoldPct < 10 ? 70 : 0,
      top10: top10Pct < 40 ? 100 : top10Pct < 60 ? 70 : 0,
      volume: volumeScore
    };
    
    const total = (scores.dev_hold * 0.4) + (scores.top10 * 0.3) + (scores.volume * 0.3);
    return { score: +total.toFixed(1) };
  } catch (e) { return { score: 0 }; }
}

// ============ TRADER ============
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const sdk = new PumpSdk(connection);

async function getRawBalance() {
  return (await connection.getBalance(wallet.publicKey)) / 1e9;
}

async function getSafeBalance() {
  const rawBal = await getRawBalance();
  const gasReserve = 0.005; 
  const usableBal = rawBal - gasReserve;
  return usableBal > 0 ? usableBal : 0;
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
    if (info.tokenAmount.uiAmount > 0) holdings.push({ mint: info.mint, amount: info.tokenAmount.uiAmount });
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
  maxCoins: 5, 
  maxLossLimit: 0.5, 
};

async function getCurrentPrice(mintStr) {
  try {
    const pData = await sdk.fetchBuyState(new PublicKey(mintStr), wallet.publicKey);
    return parseFloat(pData.bondingCurve.virtualSolReserves.toString()) / parseFloat(pData.bondingCurve.virtualTokenReserves.toString());
  } catch { return 0; }
}

// ============ AUTO TP/SL (DYNAMIC TRAILING & COMPOUNDING) ============
async function hardModeLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, 15000)); 
    if (!hardMode.active) continue;

    const mints = Object.keys(POSITIONS);
    for (const mint of mints) {
      try {
        const pnl = await getPnl(mint);
        if (!pnl) continue;

        const pos = POSITIONS[mint];
        if (!pos.peakPnlPct || pnl.pnlPct > pos.peakPnlPct) { pos.peakPnlPct = pnl.pnlPct; savePositions(); }

        let reason = null;
        let currentTrail = 0;
        if (pos.peakPnlPct >= 100) currentTrail = 25;
        else if (pos.peakPnlPct >= 80) currentTrail = 20;
        else if (pos.peakPnlPct >= 60) currentTrail = 15;
        else if (pos.peakPnlPct >= 40) currentTrail = 10;
        else if (pos.peakPnlPct >= 20) currentTrail = 5;

        if (pnl.pnlPct <= -20) reason = "CUT LOSS";
        else if (currentTrail > 0 && pnl.pnlPct <= (pos.peakPnlPct - currentTrail)) reason = "TRAILING";

        if (reason) {
          const sig = await sellAll(mint);
          delete POSITIONS[mint];
          savePositions(); 
          
          if (CHAT_ID) {
            const emoji = pnl.pnlSol >= 0 ? "🟢" : "🔴";
            await bot.telegram.sendMessage(CHAT_ID, `${emoji} *HARD ${reason}* ${mint.slice(0, 8)}\nPnL: ${pnl.pnlPct}% (${pnl.pnlSol.toFixed(4)} SOL)\ntx: \`${sig}\``, { parse_mode: "Markdown" });
          }
        }
      } catch (e) { }
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

// ============ AUTO MONITOR & COMPOUNDING ============
connection.onLogs(new PublicKey(PUMP_PROGRAM_ID), async ({ logs, signature }) => {
  try {
    if (!hardMode.active) return;
    if (!logs.some((l) => l.includes("Instruction: Create"))) return;
    
    const holdings = await getTokenHoldings();
    if (holdings.length >= hardMode.maxCoins) return;

    const safeBalance = await getSafeBalance();
    const buyAmount = safeBalance / hardMode.maxCoins;
    
    if (buyAmount < 0.002) return; 

    if (safeBalance <= (hardMode.initialBalance * hardMode.maxLossLimit)) {
      hardMode.active = false;
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, `🚨 *CIRCUIT BREAKER* 🚨\nSaldo turun 50%! Bot mati.`, { parse_mode: "Markdown" });
      return;
    }

    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
    const mint = (tx?.meta?.postTokenBalances || [])[0]?.mint;
    if (!mint) return;
    
    const res = await analyze({ mint, devWallet: tx.transaction.message.accountKeys[0]?.toString() });
    
    if (res.score >= SCORE_THRESHOLD) {
       const sig = await buy(mint, buyAmount);
       const price = await getCurrentPrice(mint);
       
       POSITIONS[mint] = { 
         entrySol: buyAmount, 
         entryPrice: price, 
         tokenAmount: buyAmount / price, 
         peakPnlPct: 0, 
         tx: sig 
       };
       savePositions();
       
       if (CHAT_ID) {
         await bot.telegram.sendMessage(CHAT_ID, `🔥 *HARD COMPOUND BUY* 🔥\n\`${mint.slice(0,8)}\` | Jatah: ${buyAmount.toFixed(4)} SOL\ntx: \`${sig}\``, { parse_mode: "Markdown" });
       }
    }
  } catch (e) { }
}, "confirmed");

// ============ BOT UI (TEMA LANOX TRADING) ============
const bot = new Telegraf(BOT_TOKEN);

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 HARD MODE MENU 🔥", "hard_menu")],
    [Markup.button.callback("💼 HOLDINGS (PnL)", "holdings")],
    [Markup.button.callback("📊 WALLET", "wallet")],
  ]);
}

const WELCOME_TEXT = 
  "📈 *LANOX TRADING MEME COIN* 📈\n\n" +
  "🤖 *Status Bot:* Siap Beraksi\n" +
  "💰 *Mode:* Hard Mode Compounding\n" +
  "⚡ *Jaringan:* Solana (Pump.fun)\n\n" +
  "Silakan pilih menu di bawah untuk mulai mencetak cuan:";

// Handler Start (Kirim Foto + Teks)
bot.start((ctx) => {
  ctx.replyWithPhoto(WELCOME_IMG, {
    caption: WELCOME_TEXT,
    parse_mode: "Markdown",
    ...menu()
  });
});

// Handler Balik ke Menu
bot.action("menu", async (ctx) => {
  try {
    // Coba edit pesan foto sebelumnya
    await ctx.editMessageCaption(WELCOME_TEXT, {
      parse_mode: "Markdown",
      ...menu()
    });
  } catch (e) {
    // Kalau gagal (misal karena pesan sebelumnya bukan foto), kirim pesan foto baru
    await ctx.replyWithPhoto(WELCOME_IMG, {
      caption: WELCOME_TEXT,
      parse_mode: "Markdown",
      ...menu()
    });
  }
});

bot.action("hard_menu", async (ctx) => {
  const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
  const text = `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\nStatus: ${status}\nMax Koin: ${hardMode.maxCoins}\nCircuit Breaker: -50%`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(hardMode.active ? "🔴 STOP HARD MODE" : "🟢 START HARD MODE", "hard_toggle")],
    [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
    [Markup.button.callback("⬅️ menu", "menu")],
  ]);
  
  try { await ctx.editMessageCaption(text, { parse_mode: "Markdown", ...kb }); }
  catch(e) { await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }); }
});

bot.action("hard_toggle", async (ctx) => {
  if (!hardMode.active) {
    const bal = await getSafeBalance();
    if (bal < 0.005) return ctx.answerCbQuery("❌ Saldo aman kurang dari 0.005 SOL!", { show_alert: true });
    hardMode.initialBalance = bal;
    hardMode.active = true;
    await ctx.answerCbQuery("Hard Mode COMPOUND ON!");
  } else {
    hardMode.active = false;
    if (MAIN_WALLET) {
      try {
        await ctx.reply("⏳ Hard Mode OFF. Menarik seluruh saldo ke wallet utama...");
        const rawBal = await getRawBalance();
        const sendAmt = rawBal - 0.00001;
        if (sendAmt > 0) {
          const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(MAIN_WALLET), lamports: Math.floor(sendAmt * LAMPORTS_PER_SOL) });
          const sig = await sendIx([ix]);
          await ctx.reply(`✅ *AUTO-WITHDRAW BERHASIL!*\nSeluruh saldo (${sendAmt.toFixed(4)} SOL) dikirim ke wallet utama.\ntx: \`${sig}\``, { parse_mode: "Markdown" });
        }
      } catch(e) { await ctx.reply(`❌ Gagal withdraw otomatis: ${e.message}`); }
    }
  }
  
  // Refresh menu hard mode
  const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
  const text = `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\nStatus: ${status}\nMax Koin: ${hardMode.maxCoins}\nCircuit Breaker: -50%`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(hardMode.active ? "🔴 STOP HARD MODE" : "🟢 START HARD MODE", "hard_toggle")],
    [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
    [Markup.button.callback("⬅️ menu", "menu")],
  ]);
  await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action("hard_sellall", async (ctx) => {
  await ctx.answerCbQuery("Jual semua...");
  const holdings = await getTokenHoldings();
  for (const h of holdings) { try { await sellAll(h.mint); delete POSITIONS[h.mint]; } catch (e) {} }
  savePositions();
  ctx.reply("✅ Semua koin berhasil dijual (SELL ALL).");
});

bot.action("holdings", async (ctx) => {
  const holdings = await getTokenHoldings();
  let text = "💼 *HOLDINGS*\n\n"; 
  const btns = [];
  for (const h of holdings) {
    const pnl = await getPnl(h.mint);
    text += pnl ? `- \`${h.mint.slice(0,6)}\` : ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%\n` : `- \`${h.mint.slice(0,6)}\`\n`;
    btns.push([Markup.button.callback(`🔴 SELL ${h.mint.slice(0,6)}`, `sellall_${h.mint}`)]);
  }
  btns.push([Markup.button.callback("⬅️ menu", "menu")]);
  
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(btns) }); }
  catch(e) { await ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(btns) }); }
});

bot.action(/^sellall_(.+)$/, async (ctx) => {
  const mint = ctx.match[1];
  await ctx.answerCbQuery("Jual...");
  try { await sellAll(mint); delete POSITIONS[mint]; savePositions(); await ctx.reply(`✅ sold 100%`); } 
  catch (e) { await ctx.reply(`❌ gagal: ${e.message}`); }
});

bot.action("wallet", async (ctx) => {
  const bal = await getRawBalance();
  const text = `📊 *WALLET BOT*\nSOL: *${bal.toFixed(4)}*\naddr: \`${wallet.publicKey.toBase58()}\``;
  const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]);
  
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }); }
  catch(e) { await ctx.reply(text, { parse_mode: "Markdown", ...kb }); }
});

hardModeLoop();
bot.launch();
console.log("📈 LANOX TRADING BOT RUNNING 📈");
