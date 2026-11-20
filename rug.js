import dotenv from "dotenv";
dotenv.config();

import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID,
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
const CHAT_ID         = process.env.CHAT_ID || "";
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const POSITIONS_FILE  = "./positions.json";

const SCORE_THRESHOLD   = parseInt(process.env.SCORE_THRESHOLD || "65");
const MAX_COINS_CFG     = parseInt(process.env.MAX_COINS || "2");
const GAS_RESERVE       = parseFloat(process.env.GAS_RESERVE || "0.008");
const SLIPPAGE_BUY      = parseFloat(process.env.SLIPPAGE_BUY || "0.06");
const SLIPPAGE_SELL     = parseFloat(process.env.SLIPPAGE_SELL || "0.10");
const PRIORITY_FEE      = parseInt(process.env.PRIORITY_FEE || "8000");
const MIN_LIQ_SOL       = parseFloat(process.env.MIN_LIQ_SOL || "12");
const REPORT_MINUTES    = parseInt(process.env.REPORT_MINUTES || "10");
const RPC_DELAY_MS      = parseInt(process.env.RPC_DELAY_MS || "2000");
const ANALYZE_COOLDOWN  = parseInt(process.env.ANALYZE_COOLDOWN_MS || "1500");

const WELCOME_IMG = "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?q=80&w=1000&auto=format&fit=crop";

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
    const json = await res.json();
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

// ============ TRADER ============
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const sdk = new PumpSdk(connection);

async function getRawBalance() {
  return (await connection.getBalance(wallet.publicKey)) / 1e9;
}
async function getSafeBalance() {
  const raw = await getRawBalance();
  const usable = raw - GAS_RESERVE;
  return usable > 0 ? usable : 0;
}

// ============ MULTI-SIGNAL ANALYZER ============
async function getHolderConcentration(mint, supply) {
  const holders = await getLargestHolders(mint);
  if (!holders.length || supply <= 0) return { top10: 100, top20: 100, count: 0 };
  const amounts = holders.map(h => parseInt(h.amount)).sort((a, b) => b - a);
  const top10 = amounts.slice(0, 10).reduce((a, b) => a + b, 0) / supply * 100;
  const top20 = amounts.slice(0, 20).reduce((a, b) => a + b, 0) / supply * 100;
  return { top10: +top10.toFixed(1), top20: +top20.toFixed(1), count: holders.length };
}

async function getLiquidity(mint) {
  try {
    const pData = await sdk.fetchBuyState(new PublicKey(mint), wallet.publicKey);
    return parseFloat(pData.bondingCurve.virtualSolReserves.toString()) / 1e9;
  } catch { return 0; }
}

async function getVolumeData(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const data = await res.json();
    if (!data.pairs || !data.pairs.length) return { vol5m: 0, vol1h: 0, buys5m: 0, sells5m: 0, priceChange5m: 0 };
    const p = data.pairs[0];
    return {
      vol5m: parseFloat(p.volume?.m5 || "0"),
      vol1h: parseFloat(p.volume?.h1 || "0"),
      buys5m: parseInt(p.txns?.m5?.buys || "0"),
      sells5m: parseInt(p.txns?.m5?.sells || "0"),
      priceChange5m: parseFloat(p.priceChange?.m5 || "0"),
    };
  } catch { return { vol5m: 0, vol1h: 0, buys5m: 0, sells5m: 0, priceChange5m: 0 }; }
}

async function getMintAuthority(mint) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.mintAuthority || null;
  } catch { return null; }
}

async function getFreezeAuthority(mint) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.freezeAuthority || null;
  } catch { return null; }
}

async function analyze({ mint }) {
  try {
    const supply = await getTokenSupply(mint);
    const [concentration, liqSol, volume, mintAuth, freezeAuth] = await Promise.all([
      getHolderConcentration(mint, supply),
      getLiquidity(mint),
      getVolumeData(mint),
      getMintAuthority(mint),
      getFreezeAuthority(mint),
    ]);

    // filter keras
    if (liqSol < MIN_LIQ_SOL) return { score: 0, reason: `liq ${liqSol.toFixed(1)} < ${MIN_LIQ_SOL}` };
    if (freezeAuth) return { score: 0, reason: `freeze authority aktif` };
    if (concentration.top10 > 85) return { score: 0, reason: `top10 ${concentration.top10}% > 85%` };

    const scores = {};

    if (concentration.top10 < 30) scores.holders = 100;
    else if (concentration.top10 < 45) scores.holders = 80;
    else if (concentration.top10 < 60) scores.holders = 50;
    else scores.holders = 20;

    if (liqSol > 80) scores.liquidity = 100;
    else if (liqSol > 50) scores.liquidity = 80;
    else if (liqSol > 30) scores.liquidity = 60;
    else scores.liquidity = 40;

    let volScore = 0;
    if (volume.vol5m > 2000) volScore = 100;
    else if (volume.vol5m > 500) volScore = 80;
    else if (volume.vol5m > 100) volScore = 50;
    else volScore = 0;

    let momentumScore = 0;
    if (volume.buys5m + volume.sells5m > 0) {
      const buyRatio = volume.buys5m / (volume.buys5m + volume.sells5m);
      if (buyRatio > 0.65) momentumScore = 100;
      else if (buyRatio > 0.55) momentumScore = 70;
      else if (buyRatio > 0.45) momentumScore = 40;
      else momentumScore = 0;
    }
    if (volume.priceChange5m > 5 && volume.priceChange5m < 50) momentumScore = Math.min(100, momentumScore + 20);
    else if (volume.priceChange5m >= 100) momentumScore = Math.max(0, momentumScore - 30);

    scores.volume = Math.round((volScore * 0.6) + (momentumScore * 0.4));

    scores.authority = mintAuth ? 50 : 100;

    if (concentration.count > 60) scores.holders_count = 100;
    else if (concentration.count > 30) scores.holders_count = 80;
    else if (concentration.count > 10) scores.holders_count = 50;
    else scores.holders_count = 20;

    const total =
      scores.holders * 0.25 +
      scores.liquidity * 0.20 +
      scores.volume * 0.25 +
      scores.authority * 0.15 +
      scores.holders_count * 0.15;

    return {
      score: +total.toFixed(1),
      reason: `top10 ${concentration.top10}% liq ${liqSol.toFixed(0)} vol5m $${volume.vol5m.toFixed(0)} buy ${volume.buys5m}/${volume.sells5m} auth ${mintAuth ? "ada" : "revoked"}`,
    };
  } catch (e) {
    return { score: 0, reason: `analyze error: ${e.message}` };
  }
}

// ============ SEND IX ============
async function sendIx(instructions, extraSigners = []) {
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE });
  const allIx = [priorityIx, ...instructions];
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: allIx,
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([wallet, ...extraSigners]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
      return sig;
    } catch (e) {
      lastErr = e;
      console.error(`sendIx attempt ${attempt + 1} failed:`, e.message);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ============ BUY / SELL ============
async function buy(mintStr, solAmount) {
  const mint = new PublicKey(mintStr);
  const lamports = Math.floor(solAmount * 1e9);
  const state = await sdk.fetchBuyState(mint, wallet.publicKey);
  const price = parseFloat(state.bondingCurve.virtualSolReserves.toString()) /
                parseFloat(state.bondingCurve.virtualTokenReserves.toString());
  const expectedTokens = (solAmount / price);
  const minTokens = Math.floor(expectedTokens * (1 - SLIPPAGE_BUY));
  const ix = await sdk.buyInstructions({
    bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: wallet.publicKey,
    solAmount: BigInt(lamports), amount: BigInt(minTokens), slippage: SLIPPAGE_BUY,
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
    amount: raw, slippage: SLIPPAGE_SELL,
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

// ============ STATE ============
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

async function getCurrentPrice(mintStr) {
  try {
    const pData = await sdk.fetchBuyState(new PublicKey(mintStr), wallet.publicKey);
    return parseFloat(pData.bondingCurve.virtualSolReserves.toString()) /
           parseFloat(pData.bondingCurve.virtualTokenReserves.toString());
  } catch { return 0; }
}

// ============ AUTO TP/SL ============
async function hardModeLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 15000));
    if (!hardMode.active) continue;
    for (const mint of Object.keys(POSITIONS)) {
      try {
        const pnl = await getPnl(mint);
        if (!pnl) continue;
        const pos = POSITIONS[mint];
        if (!pos.peakPnlPct || pnl.pnlPct > pos.peakPnlPct) { pos.peakPnlPct = pnl.pnlPct; savePositions(); }
        let reason = null, trail = 0;
        if (pos.peakPnlPct >= 100) trail = 25;
        else if (pos.peakPnlPct >= 80) trail = 20;
        else if (pos.peakPnlPct >= 60) trail = 15;
        else if (pos.peakPnlPct >= 40) trail = 10;
        else if (pos.peakPnlPct >= 20) trail = 5;
        if (pnl.pnlPct <= -15) reason = "CUT LOSS";
        else if (trail > 0 && pnl.pnlPct <= (pos.peakPnlPct - trail)) reason = "TRAILING";
        if (reason) {
          const sig = await sellAll(mint);
          delete POSITIONS[mint]; savePositions();
          if (CHAT_ID) {
            const emoji = pnl.pnlSol >= 0 ? "🟢" : "🔴";
            await bot.telegram.sendMessage(CHAT_ID,
              `${emoji} *HARD ${reason}* ${mint.slice(0, 8)}\nPnL: ${pnl.pnlPct}% (${pnl.pnlSol.toFixed(4)} SOL)\ntx: \`${sig}\``,
              { parse_mode: "Markdown" });
          }
        }
      } catch (e) { console.error("loop error", mint, e.message); }
    }
  }
}

async function getPnl(mint) {
  const pos = POSITIONS[mint]; if (!pos) return null;
  const current = await getCurrentPrice(mint); if (!current || !pos.entryPrice) return null;
  const currentValueSol = current * pos.tokenAmount;
  const pnlSol = currentValueSol - pos.entrySol;
  return { pnlSol: +pnlSol.toFixed(4), pnlPct: +((pnlSol / pos.entrySol) * 100).toFixed(1) };
}

// ============ AUTO MONITOR ============
const seenSignatures = new Set();
let lastAnalyzeTime = 0;

connection.onLogs(new PublicKey(PUMP_PROGRAM_ID), async ({ logs, signature }) => {
  try {
    if (!hardMode.active) return;
    if (!logs.some(l => l.includes("Instruction: Create"))) return;

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
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, `🚨 *CIRCUIT BREAKER* 🚨\nSaldo turun 50%! Bot mati.`, { parse_mode: "Markdown" });
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
    if (!tx || !tx.transaction || !tx.transaction.message) return;

    const postBalances = tx.meta?.postTokenBalances || [];
    const mint = postBalances[0]?.mint;
    if (!mint) return;

    const res = await analyze({ mint });
    console.log(`analyze ${mint.slice(0,8)}: skor ${res.score} | ${res.reason}`);

    if (res.score >= SCORE_THRESHOLD) {
      const sig = await buy(mint, buyAmount);
      const price = await getCurrentPrice(mint);
      POSITIONS[mint] = { entrySol: buyAmount, entryPrice: price, tokenAmount: buyAmount / price, peakPnlPct: 0, tx: sig };
      savePositions();
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID,
        `🔥 *BUY* \`${mint.slice(0, 8)}\` | ${buyAmount.toFixed(4)} SOL | skor ${res.score} (${res.reason})\ntx: \`${sig}\``,
        { parse_mode: "Markdown" });
    }
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
const WELCOME_TEXT =
  "📈 *LANOX TRADING MEME COIN* 📈\n\n" +
  "🤖 *Status Bot:* Siap Beraksi\n" +
  "💰 *Mode:* Hard Mode Compounding\n" +
  "⚡ *Jaringan:* Solana (Pump.fun)\n\n" +
  "Silakan pilih menu di bawah untuk mulai mencetak cuan:";

async function safeEdit(ctx, text, keyboard) {
  const opts = { parse_mode: "Markdown", ...keyboard };
  try { await ctx.editMessageCaption(text, opts); return; } catch {}
  try { await ctx.editMessageText(text, opts); return; } catch {}
  try { await ctx.reply(text, opts); } catch (e) { console.error("safeEdit:", e.message); }
}

bot.start(ctx => ctx.replyWithPhoto(WELCOME_IMG, { caption: WELCOME_TEXT, parse_mode: "Markdown", ...menu() })
  .catch(() => ctx.reply(WELCOME_TEXT, { parse_mode: "Markdown", ...menu() }).catch(() => {})));
bot.action("menu", ctx => safeEdit(ctx, WELCOME_TEXT, menu()));

bot.action("hard_menu", async ctx => {
  const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
  const text = `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\nStatus: ${status}\nMax Koin: ${currentMaxCoins()}\nCircuit Breaker: -50%\nScore Min: ${SCORE_THRESHOLD}\nSlippage: ${(SLIPPAGE_BUY*100).toFixed(0)}%/${(SLIPPAGE_SELL*100).toFixed(0)}%`;
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
      if (bal < 0.01) return ctx.answerCbQuery("❌ Saldo aman < 0.01 SOL. Isi dulu wallet bot!", { show_alert: true });
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
            const sig = await sendIx([ix]);
            await ctx.reply(`✅ *WITHDRAW OK*\n${sendAmt.toFixed(4)} SOL → main\ntx: \`${sig}\``, { parse_mode: "Markdown" });
          }
        } catch (e) { await ctx.reply(`❌ Withdraw gagal: ${e.message}`); }
      }
    }
    const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
    const text = `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\nStatus: ${status}\nMax Koin: ${currentMaxCoins()}\nCircuit Breaker: -50%\nScore Min: ${SCORE_THRESHOLD}\nSlippage: ${(SLIPPAGE_BUY*100).toFixed(0)}%/${(SLIPPAGE_SELL*100).toFixed(0)}%`;
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
      try { await sellAll(h.mint); delete POSITIONS[h.mint]; ok++; } catch { fail++; }
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
      const pnl = await getPnl(h.mint);
      text += pnl ? `- \`${h.mint.slice(0,6)}\` : ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%\n` : `- \`${h.mint.slice(0,6)}\`\n`;
      btns.push([Markup.button.callback(`🔴 SELL ${h.mint.slice(0,6)}`, `sellall_${h.mint}`)]);
    }
    btns.push([Markup.button.callback("⬅️ menu", "menu")]);
    await safeEdit(ctx, text, Markup.inlineKeyboard(btns));
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

bot.action(/^sellall_(.+)$/, async ctx => {
  const mint = ctx.match[1];
  try { await ctx.answerCbQuery("Jual..."); await sellAll(mint); delete POSITIONS[mint]; savePositions(); await ctx.reply(`✅ sold \`${mint.slice(0,8)}\``, { parse_mode: "Markdown" }); }
  catch (e) { await ctx.reply(`❌ gagal: ${e.message}`); }
});

bot.action("wallet", async ctx => {
  try {
    const bal = await getRawBalance();
    const text = `📊 *WALLET BOT*\nSOL: *${bal.toFixed(4)}*\naddr: \`${wallet.publicKey.toBase58()}\``;
    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]));
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

// ============ LAPORAN TIAP 10 MENIT ============
async function reportLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, REPORT_MINUTES * 60 * 1000));
    if (!CHAT_ID) continue;
    try {
      const rawBal = await getRawBalance();
      const safeBal = await getSafeBalance();
      const holdings = await getTokenHoldings();

      let totalPnlSol = 0;
      let posLines = "";
      for (const h of holdings) {
        const pnl = await getPnl(h.mint);
        if (pnl) {
          totalPnlSol += pnl.pnlSol;
          const sign = pnl.pnlPct >= 0 ? "+" : "";
          posLines += `  • \`${h.mint.slice(0, 6)}\` ${sign}${pnl.pnlPct}% (${sign}${pnl.pnlSol} SOL)\n`;
        } else {
          posLines += `  • \`${h.mint.slice(0, 6)}\` —\n`;
        }
      }

      const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
      const pnlSign = totalPnlSol >= 0 ? "+" : "";
      const text =
        `📊 *LAPORAN ${REPORT_MINUTES} MENIT*\n\n` +
        `Status: ${status}\n` +
        `Saldo: *${rawBal.toFixed(4)} SOL* (safe: ${safeBal.toFixed(4)})\n` +
        `Posisi: ${holdings.length}/${currentMaxCoins()}\n` +
        `PnL terbuka: ${pnlSign}${totalPnlSol.toFixed(4)} SOL\n\n` +
        (posLines ? `*Detail:*\n${posLines}` : `_Tidak ada posisi terbuka._`);

      await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("reportLoop error:", e.message);
    }
  }
}

// ============ GUARDS ============
process.on("unhandledRejection", r => console.error("⚠️ Unhandled:", r?.message || r));
process.on("uncaughtException", e => console.error("⚠️ Uncaught:", e?.message || e));

hardModeLoop().catch(e => console.error("loop crashed:", e.message));
reportLoop().catch(e => console.error("report crashed:", e.message));
bot.catch((err, ctx) => console.error(`Telegraf ${ctx?.updateType}:`, err.message));
bot.launch();
console.log("📈 LANOX BOT RUNNING — MULTI-SIGNAL AUTO-TUNED 📈");
