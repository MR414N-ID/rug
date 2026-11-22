import dotenv from "dotenv";
dotenv.config();

import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
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
const CHAT_ID         = process.env.CHAT_ID || "";
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const POSITIONS_FILE  = "./positions.json";

const SCORE_THRESHOLD   = parseInt(process.env.SCORE_THRESHOLD || "10");
const MAX_COINS_CFG     = parseInt(process.env.MAX_COINS || "2");
const GAS_RESERVE       = parseFloat(process.env.GAS_RESERVE || "0.008");
const SLIPPAGE_BUY      = parseFloat(process.env.SLIPPAGE_BUY || "0.10");
const SLIPPAGE_SELL     = parseFloat(process.env.SLIPPAGE_SELL || "0.10");
const PRIORITY_FEE      = parseInt(process.env.PRIORITY_FEE || "8000");
const MIN_LIQ_SOL       = parseFloat(process.env.MIN_LIQ_SOL || "5");
const MAX_LIQ_SOL       = parseFloat(process.env.MAX_LIQ_SOL || "500");
const MAX_AGE_HOURS     = parseFloat(process.env.MAX_AGE_HOURS || "20");
const REPORT_MINUTES    = parseInt(process.env.REPORT_MINUTES || "10");
const RPC_DELAY_MS      = parseInt(process.env.RPC_DELAY_MS || "2000");
const ANALYZE_COOLDOWN  = parseInt(process.env.ANALYZE_COOLDOWN_MS || "3500");

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const WELCOME_IMG = "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?q=80&w=1000&auto=format&fit=crop";

// ============ CURRENCY ============
const priceCache = { solUsd: 140, usdIdr: 16000, lastUpdate: 0 };
async function updatePrices() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,idr");
    const data = await res.json();
    if (data.solana?.usd && data.solana?.idr) {
      priceCache.solUsd = data.solana.usd;
      priceCache.usdIdr = data.solana.idr / data.solana.usd;
      priceCache.lastUpdate = Date.now();
    }
  } catch (e) { console.error("updatePrices:", e.message); }
}
function solToIdr(sol) { return Math.round(sol * priceCache.solUsd * priceCache.usdIdr); }
function fmtIdr(sol) { return `Rp ${solToIdr(sol).toLocaleString('id-ID')}`; }
function fmtPnl(sol) {
  const sign = sol >= 0 ? "+" : "-";
  return `${sign}${Math.abs(sol).toFixed(4)} SOL (~${sign}${fmtIdr(Math.abs(sol))})`;
}

// ============ RPC HELPERS ============
let isRpcBusy = false;
let rpcDelay = RPC_DELAY_MS;
async function rpc(method, params) {
  if (isRpcBusy) await new Promise(r => setTimeout(r, rpcDelay));
  isRpcBusy = true;
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      rpcDelay = Math.min(rpcDelay * 2, 10000);
      await new Promise(r => setTimeout(r, rpcDelay));
      return null;
    }
    if (json.error && json.error.code === 429) {
      rpcDelay = Math.min(rpcDelay * 2, 10000);
      await new Promise(r => setTimeout(r, rpcDelay));
    } else {
      rpcDelay = Math.max(500, Math.floor(rpcDelay * 0.9));
    }
    return json.result;
  } finally {
    setTimeout(() => { isRpcBusy = false; }, 300);
  }
}

async function getTokenSupply(mint) {
  const r = await rpc("getTokenSupply", [mint]);
  return r?.value ? parseInt(r.value.amount) : 0;
}
async function getLargestHolders(mint) {
  return (await rpc("getTokenLargestAccounts", [mint]))?.value || [];
}

// ============ TRADER & SDK INIT ============
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const sdk = new PumpSdk(connection);

async function getRawBalance() {
  return (await connection.getBalance(wallet.publicKey)) / 1e9;
}
async function getSafeBalance() {
  const raw = await getRawBalance();
  const usable = raw - GAS_RESERVE;
  return usable > 0 ? usable : 0;
}

async function getBondingCurveState(mintStr) {
  try {
    const state = await sdk.fetchBuyState(new PublicKey(mintStr), wallet.publicKey);
    return {
      pda: state.bondingCurveAccountInfo.pubkey,
      virtualTokenReserves: state.bondingCurve.virtualTokenReserves,
      virtualSolReserves:   state.bondingCurve.virtualSolReserves,
      complete:             state.bondingCurve.complete,
    };
  } catch { return null; }
}

async function getCurrentPrice(mintStr) {
  const st = await getBondingCurveState(mintStr);
  if (!st || st.virtualTokenReserves === 0n) return 0;
  return Number(st.virtualSolReserves) / Number(st.virtualTokenReserves);
}

async function executeBuy(mintStr, solAmount) {
  const mint = new PublicKey(mintStr);
  const lamports = Math.floor(solAmount * 1e9);
  const state = await sdk.fetchBuyState(mint, wallet.publicKey);
  
  const ixs = await sdk.buyInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint,
    user: wallet.publicKey,
    solAmount: BigInt(lamports),
    amount: BigInt(0),
    slippage: SLIPPAGE_BUY,
  });

  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: [priorityIx, ...ixs],
  }).compileToV0Message();
  
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function executeSell(mintStr) {
  const mint = new PublicKey(mintStr);
  const info = await connection.getTokenAccountBalance(await getAssociatedTokenAddress(mint, wallet.publicKey)).catch(() => null);
  if (!info || info.value.amount === "0") throw new Error("no balance");

  const rawAmount = BigInt(info.value.amount);
  const state = await sdk.fetchSellState(mint, wallet.publicKey);

  const ixs = await sdk.sellInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint,
    user: wallet.publicKey,
    amount: rawAmount,
    slippage: SLIPPAGE_SELL,
  });

  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: [priorityIx, ...ixs],
  }).compileToV0Message();
  
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function getTokenHoldings() {
  const holdings = [];
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    if (info.tokenAmount.uiAmount > 0) holdings.push({ mint: info.mint, amount: info.tokenAmount.uiAmount });
  }
  return holdings;
}

// ============ STATE & TP/SL ============
let POSITIONS = {};
if (fs.existsSync(POSITIONS_FILE)) { try { POSITIONS = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8")); } catch {} }
function savePositions() { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(POSITIONS, null, 2)); }

const hardMode = { active: false, initialBalance: 0, maxLossLimit: 0.5 };
function currentMaxCoins() {
  const bal = hardMode.initialBalance || 0;
  if (bal < 0.04) return 2;
  if (bal < 0.08) return 3;
  return Math.min(MAX_COINS_CFG, 4);
}

async function hardModeLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 15000));
    if (!hardMode.active) continue;
    for (const mint of Object.keys(POSITIONS)) {
      try {
        const currentPrice = await getCurrentPrice(mint);
        if (!currentPrice) continue;
        const pos = POSITIONS[mint];
        const currentValueSol = currentPrice * pos.tokenAmount;
        const pnlSol = currentValueSol - pos.entrySol;
        const pnlPct = (pnlSol / pos.entrySol) * 100;
        
        if (!pos.peakPnlPct || pnlPct > pos.peakPnlPct) { pos.peakPnlPct = pnlPct; savePositions(); }

        let reason = null, trail = 0;
        if (pos.peakPnlPct >= 100) trail = 25;
        else if (pos.peakPnlPct >= 80) trail = 20;
        else if (pos.peakPnlPct >= 60) trail = 15;
        else if (pos.peakPnlPct >= 40) trail = 10;
        else if (pos.peakPnlPct >= 20) trail = 5;

        if (pnlPct <= -15) reason = "CUT LOSS";
        else if (trail > 0 && pnlPct <= (pos.peakPnlPct - trail)) reason = "TRAILING";

        if (reason) {
          const sig = await executeSell(mint);
          delete POSITIONS[mint]; savePositions();
          if (CHAT_ID) {
            const emoji = pnlSol >= 0 ? "🟢" : "🔴";
            await bot.telegram.sendMessage(CHAT_ID,
              `${emoji} *HARD ${reason}* ${mint.slice(0, 8)}\nPnL: ${pnlPct.toFixed(1)}% (${fmtPnl(pnlSol)})\ntx: \`${sig}\``,
              { parse_mode: "Markdown" });
          }
        }
      } catch (e) { console.error("loop error", mint, e.message); }
    }
  }
}

// ============ MONITOR & BUY ============
const seenSignatures = new Set();
const processedMints = new Map();
const MINT_COOLDOWN = 5 * 60 * 1000;
let lastAnalyzeTime = 0;

connection.onLogs(PUMP_PROGRAM, async ({ logs, signature }) => {
  try {
    if (!hardMode.active) return;
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);
    if (seenSignatures.size > 2000) seenSignatures.clear();

    const now = Date.now();
    if (now - lastAnalyzeTime < ANALYZE_COOLDOWN) return;
    lastAnalyzeTime = now;

    const rawBal = await getRawBalance();
    if (rawBal < GAS_RESERVE + 0.005) return;
    const holdings = await getTokenHoldings();
    if (holdings.length >= currentMaxCoins()) return;
    
    const safeBalance = await getSafeBalance();
    if (safeBalance <= (hardMode.initialBalance * hardMode.maxLossLimit)) {
      hardMode.active = false;
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, `🚨 *CIRCUIT BREAKER* 🚨\nSaldo turun 50%!`, { parse_mode: "Markdown" });
      return;
    }

    const buyAmount = safeBalance / currentMaxCoins();
    if (buyAmount < 0.003) return;

    let tx = null;
    for (let i = 0; i < 5; i++) {
      tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
      if (tx) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!tx || !tx.meta) return;

    const postBalances = tx.meta.postTokenBalances || [];
    const candidates = [...new Set(postBalances.map(b => b.mint).filter(Boolean))].filter(m => m !== WSOL_MINT && m !== USDC_MINT);
    if (!candidates.length) return;

    let mint = null;
    for (const c of candidates) {
      const last = processedMints.get(c) || 0;
      if (now - last < MINT_COOLDOWN) continue;
      if (await getBondingCurveState(c)) { mint = c; processedMints.set(c, now); break; }
    }
    if (!mint) return;

    console.log(`\n✅ DAPET TOKEN PUMP.FUN! Mint: ${mint.slice(0,8)}`);
    
    const sig = await executeBuy(mint, buyAmount);
    const price = await getCurrentPrice(mint);
    POSITIONS[mint] = { entrySol: buyAmount, entryPrice: price, tokenAmount: buyAmount / price, peakPnlPct: 0, tx: sig };
    savePositions();
    
    if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID,
      `🔥 *BUY (SDK)* \`${mint.slice(0, 8)}\`\nAmount: *${buyAmount.toFixed(4)} SOL (~${fmtIdr(buyAmount)})*\ntx: \`${sig}\``,
      { parse_mode: "Markdown" });
      
  } catch (e) { console.error("onLogs error:", e.message); }
}, "confirmed");

// ============ BOT UI ============
const bot = new Telegraf(BOT_TOKEN);
function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 HARD MODE MENU 🔥", "hard_menu")],
    [Markup.button.callback("💼 HOLDINGS (PnL)", "holdings")],
    [Markup.button.callback("📊 WALLET", "wallet")],
  ]);
}
function welcomeText() {
  const rate = Math.round(priceCache.solUsd * priceCache.usdIdr);
  return (
    "📈 *LANOX TRADING MEME COIN* 📈\n\n" +
    `💱 Rate: 1 SOL ≈ *Rp ${rate.toLocaleString('id-ID')}*\n` +
    `⏱️ Filter umur: max *${MAX_AGE_HOURS} jam*\n` +
    "⚡ Engine: *Pump SDK vLatest*\n\n" +
    "Silakan pilih menu di bawah:"
  );
}

async function safeEdit(ctx, text, keyboard) {
  const opts = { parse_mode: "Markdown", ...keyboard };
  try { await ctx.editMessageCaption(text, opts); return; } catch {}
  try { await ctx.editMessageText(text, opts); return; } catch {}
  try { await ctx.reply(text, opts); } catch (e) { console.error("safeEdit:", e.message); }
}

bot.start(ctx => ctx.replyWithPhoto(WELCOME_IMG, { caption: welcomeText(), parse_mode: "Markdown", ...menu() })
  .catch(() => ctx.reply(welcomeText(), { parse_mode: "Markdown", ...menu() }).catch(() => {})));
bot.action("menu", ctx => safeEdit(ctx, welcomeText(), menu()));

async function hardMenuText() {
  const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
  const bal = await getRawBalance();
  return (
    `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\nStatus: ${status}\nMax Koin: ${currentMaxCoins()}\nScore Min: ${SCORE_THRESHOLD}\nCircuit: -50%\n\nSaldo: *${bal.toFixed(4)} SOL*\n(~${fmtIdr(bal)})`
  );
}

bot.action("hard_menu", async ctx => {
  const text = await hardMenuText();
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(hardMode.active ? "🔴 STOP HARD MODE" : "🟢 START HARD MODE", "hard_toggle")],
    [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
    [Markup.button.callback("⬅️ menu", "menu")],
  ]);
  await safeEdit(ctx, text, kb);
});

bot.action("hard_toggle", async ctx => {
  try {
    if (!hardMode.active) {
      const bal = await getSafeBalance();
      if (bal < 0.01) return ctx.answerCbQuery("❌ Saldo aman < 0.01 SOL!", { show_alert: true });
      hardMode.initialBalance = bal;
      hardMode.active = true;
      await ctx.answerCbQuery("Hard Mode ON!");
    } else {
      hardMode.active = false;
      if (MAIN_WALLET) {
        try {
          await ctx.reply("⏳ Withdraw ke main wallet...");
          const raw = await getRawBalance();
          const sendAmt = raw - 0.00001;
          if (sendAmt > 0) {
            const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(MAIN_WALLET), lamports: Math.floor(sendAmt * LAMPORTS_PER_SOL) });
            const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE });
            const { blockhash } = await connection.getLatestBlockhash("confirmed");
            const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: [priorityIx, ix] }).compileToV0Message();
            const tx = new VersionedTransaction(msg);
            tx.sign([wallet]);
            const sig = await connection.sendRawTransaction(tx.serialize());
            await ctx.reply(`✅ *WITHDRAW OK*\n${sendAmt.toFixed(4)} SOL (~${fmtIdr(sendAmt)}) → main\ntx: \`${sig}\``, { parse_mode: "Markdown" });
          }
        } catch (e) { await ctx.reply(`❌ Withdraw gagal: ${e.message}`); }
      }
    }
    const text = await hardMenuText();
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(hardMode.active ? "🔴 STOP HARD MODE" : "🟢 START HARD MODE", "hard_toggle")],
      [Markup.button.callback("💼 SELL ALL NOW", "hard_sellall")],
      [Markup.button.callback("⬅️ menu", "menu")],
    ]);
    await safeEdit(ctx, text, kb);
  } catch (e) { console.error("toggle:", e.message); try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

bot.action("hard_sellall", async ctx => {
  try {
    await ctx.answerCbQuery("Jual semua...");
    const holdings = await getTokenHoldings();
    let ok = 0, fail = 0;
    for (const h of holdings) {
      try { await executeSell(h.mint); delete POSITIONS[h.mint]; ok++; } catch { fail++; }
    }
    savePositions();
    await ctx.reply(`✅ SELL ALL: ${ok} sukses, ${fail} gagal`);
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

bot.action("holdings", async ctx => {
  try {
    const holdings = await getTokenHoldings();
    let text = "💼 *HOLDINGS*\n\n";
    const btns = [];
    if (!holdings.length) text += "_Tidak ada token._";
    for (const h of holdings) {
      const current = await getCurrentPrice(h.mint);
      const pos = POSITIONS[h.mint];
      if (current && pos) {
        const pnlSol = (current * pos.tokenAmount) - pos.entrySol;
        const pnlPct = (pnlSol / pos.entrySol) * 100;
        text += `- \`${h.mint.slice(0,6)}\` : ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%\n  ${fmtPnl(pnlSol)}\n`;
      } else {
        text += `- \`${h.mint.slice(0,6)}\`\n`;
      }
      btns.push([Markup.button.callback(`🔴 SELL ${h.mint.slice(0,6)}`, `sellall_${h.mint}`)]);
    }
    btns.push([Markup.button.callback("⬅️ menu", "menu")]);
    await safeEdit(ctx, text, Markup.inlineKeyboard(btns));
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

bot.action(/^sellall_(.+)$/, async ctx => {
  const mint = ctx.match[1];
  try { await ctx.answerCbQuery("Jual..."); await executeSell(mint); delete POSITIONS[mint]; savePositions(); await ctx.reply(`✅ sold \`${mint.slice(0,8)}\``, { parse_mode: "Markdown" }); }
  catch (e) { await ctx.reply(`❌ gagal: ${e.message}`); }
});

bot.action("wallet", async ctx => {
  try {
    const bal = await getRawBalance();
    const text = `📊 *WALLET BOT*\n\nSOL: *${bal.toFixed(4)}*\nIDR: *${fmtIdr(bal)}*\n\naddr: \`${wallet.publicKey.toBase58()}\``;
    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]));
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

// ============ LAPORAN ============
async function reportLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, REPORT_MINUTES * 60 * 1000));
    if (!CHAT_ID) continue;
    try {
      const rawBal = await getRawBalance();
      const holdings = await getTokenHoldings();
      let totalPnlSol = 0;
      let posLines = "";
      for (const h of holdings) {
        const current = await getCurrentPrice(h.mint);
        const pos = POSITIONS[h.mint];
        if (current && pos) {
           const pnlSol = (current * pos.tokenAmount) - pos.entrySol;
           totalPnlSol += pnlSol;
           posLines += `  • \`${h.mint.slice(0, 6)}\` ${fmtPnl(pnlSol)}\n`;
        }
      }
      const text = `📊 *LAPORAN ${REPORT_MINUTES} MENIT*\n\nStatus: ${hardMode.active ? "🟢 ON" : "🔴 OFF"}\nSaldo: *${rawBal.toFixed(4)} SOL* (~${fmtIdr(rawBal)})\nPnL terbuka: *${fmtPnl(totalPnlSol)}*\n\n${posLines || "_Tidak ada posisi._"}`;
      await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" });
    } catch (e) { console.error("report error:", e.message); }
  }
}

async function rateLoop() {
  await updatePrices();
  while (true) { await new Promise(r => setTimeout(r, 5 * 60 * 1000)); await updatePrices(); }
}

// ============ GUARDS ============
process.on("unhandledRejection", r => console.error("⚠️ Unhandled:", r?.message || r));
process.on("uncaughtException", e => console.error("⚠️ Uncaught:", e?.message || e));

hardModeLoop().catch(e => console.error("loop crashed:", e.message));
reportLoop().catch(e => console.error("report crashed:", e.message));
rateLoop().catch(e => console.error("rate crashed:", e.message));
bot.catch((err, ctx) => console.error(`Telegraf ${ctx?.updateType}:`, err.message));
bot.launch();
console.log("📈 LANOX BOT RUNNING — FULL SDK ENGINE + ANTI-429 📈");

getRawBalance().then(b => console.log(`💰 Saldo Wallet Bot: ${b.toFixed(4)} SOL`));
