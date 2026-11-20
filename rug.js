import dotenv from "dotenv";
dotenv.config();

import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  TransactionMessage, SystemProgram, LAMPORTS_PER_SOL,
  ComputeBudgetProgram, TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
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

const SCORE_THRESHOLD   = parseInt(process.env.SCORE_THRESHOLD || "50");
const MAX_COINS_CFG     = parseInt(process.env.MAX_COINS || "2");
const GAS_RESERVE       = parseFloat(process.env.GAS_RESERVE || "0.008");
const SLIPPAGE_BUY      = parseFloat(process.env.SLIPPAGE_BUY || "0.08");
const SLIPPAGE_SELL     = parseFloat(process.env.SLIPPAGE_SELL || "0.12");
const PRIORITY_FEE      = parseInt(process.env.PRIORITY_FEE || "8000");
const MIN_LIQ_SOL       = parseFloat(process.env.MIN_LIQ_SOL || "8");
const MAX_LIQ_SOL       = parseFloat(process.env.MAX_LIQ_SOL || "500");
const MAX_AGE_HOURS     = parseFloat(process.env.MAX_AGE_HOURS || "6");
const REPORT_MINUTES    = parseInt(process.env.REPORT_MINUTES || "10");
const RPC_DELAY_MS      = parseInt(process.env.RPC_DELAY_MS || "1500");
const ANALYZE_COOLDOWN  = parseInt(process.env.ANALYZE_COOLDOWN_MS || "800");

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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
function fmtAge(hours) {
  if (hours == null) return "?";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}j`;
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

// ============ TRADER ============
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const SYS_PROGRAM = SystemProgram.programId;
const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");

async function getRawBalance() {
  return (await connection.getBalance(wallet.publicKey)) / 1e9;
}
async function getSafeBalance() {
  const raw = await getRawBalance();
  const usable = raw - GAS_RESERVE;
  return usable > 0 ? usable : 0;
}

// ============ MINT PROGRAM DETECTION ============
async function getMintProgram(mintStr) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mintStr));
    if (info.value?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    return TOKEN_PROGRAM_ID;
  } catch { return TOKEN_PROGRAM_ID; }
}

// ============ PDAs & BONDING CURVE ============
function getBondingCurvePDA(mintStr) {
  const mint = new PublicKey(mintStr);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM
  );
  return pda;
}
function getGlobalPDA() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM);
  return pda;
}
function getEventAuthorityPDA() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM);
  return pda;
}
function getCreatorVaultPDA(creator) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMP_PROGRAM
  );
  return pda;
}

async function isPumpToken(mintStr) {
  try {
    const pda = getBondingCurvePDA(mintStr);
    const info = await connection.getAccountInfo(pda);
    return !!info;
  } catch { return false; }
}

async function getBondingCurveState(mintStr) {
  const pda = getBondingCurvePDA(mintStr);
  const info = await connection.getAccountInfo(pda);
  if (!info || info.data.length < 81) return null;
  return {
    pda,
    virtualTokenReserves: info.data.readBigUInt64LE(8),
    virtualSolReserves:   info.data.readBigUInt64LE(16),
    realTokenReserves:    info.data.readBigUInt64LE(24),
    realSolReserves:      info.data.readBigUInt64LE(32),
    tokenTotalSupply:     info.data.readBigUInt64LE(40),
    complete:             info.data[48] === 1,
    creator:              new PublicKey(info.data.slice(49, 81)),
  };
}

async function getLiquidity(mint) {
  try {
    const st = await getBondingCurveState(mint);
    if (!st) return 0;
    return Number(st.virtualSolReserves) / 1e9;
  } catch { return 0; }
}

async function getCurrentPrice(mintStr) {
  try {
    const st = await getBondingCurveState(mintStr);
    if (!st || st.virtualTokenReserves === 0n) return 0;
    return Number(st.virtualSolReserves) / Number(st.virtualTokenReserves);
  } catch { return 0; }
}

// ============ ON-CHAIN AGE + ACTIVITY ============
async function getTokenActivity(mintStr) {
  try {
    const mint = new PublicKey(mintStr);
    const pda = getBondingCurvePDA(mintStr);
    const now = Date.now() / 1000;

    let ageHours = null;
    try {
      const mintSigs = await connection.getSignaturesForAddress(mint, { limit: 1000 });
      if (mintSigs.length) {
        const oldest = mintSigs[mintSigs.length - 1];
        if (oldest.blockTime) {
          ageHours = Math.max(0, (now - oldest.blockTime) / 3600);
        }
      }
    } catch {}

    let txCount5m = 0;
    let txCount30m = 0;
    try {
      const bcSigs = await connection.getSignaturesForAddress(pda, { limit: 200 });
      for (const s of bcSigs) {
        if (!s.blockTime) continue;
        const age = now - s.blockTime;
        if (age <= 300) txCount5m++;
        if (age <= 1800) txCount30m++;
      }
    } catch {}

    return { ageHours, txCount5m, txCount30m };
  } catch {
    return { ageHours: null, txCount5m: 0, txCount30m: 0 };
  }
}

// ============ FEE RECIPIENT ============
let cachedFeeRecipient = null;
async function getFeeRecipient() {
  if (cachedFeeRecipient) return cachedFeeRecipient;
  try {
    const globalPDA = getGlobalPDA();
    const info = await connection.getAccountInfo(globalPDA);
    if (info && info.data.length >= 73) {
      cachedFeeRecipient = new PublicKey(info.data.slice(41, 73));
      return cachedFeeRecipient;
    }
  } catch (e) { console.error("getFeeRecipient:", e.message); }
  cachedFeeRecipient = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
  return cachedFeeRecipient;
}

// ============ MANUAL BUY / SELL ============
const BUY_DISC  = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISC = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

async function buildBuyIx(mintStr, solAmount) {
  const mint = new PublicKey(mintStr);
  const state = await getBondingCurveState(mintStr);
  if (!state) throw new Error("bonding curve not found");
  if (state.complete) throw new Error("token graduated");

  const mintProgram = await getMintProgram(mintStr);
  const feeRecipient = await getFeeRecipient();
  const creatorVault = getCreatorVaultPDA(state.creator);
  const associatedBondingCurve = await getAssociatedTokenAddress(mint, state.pda, true, mintProgram);
  const associatedUser = await getAssociatedTokenAddress(mint, wallet.publicKey, false, mintProgram);

  const solLamports = BigInt(Math.floor(solAmount * 1e9));
  const solAfterFee = solLamports * 99n / 100n;
  const tokensOut = (solAfterFee * state.virtualTokenReserves) / (state.virtualSolReserves + solAfterFee);
  const minTokensOut = tokensOut * BigInt(Math.floor((1 - SLIPPAGE_BUY) * 100)) / 100n;

  if (minTokensOut <= 0n) throw new Error("min tokens zero");

  // FIX: bikin ATA user dulu pakai program yang sesuai mint
  const ixAta = createAssociatedTokenAccountIdempotentInstruction(
    wallet.publicKey,
    associatedUser,
    wallet.publicKey,
    mint,
    mintProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const data = Buffer.alloc(24);
  BUY_DISC.copy(data, 0);
  data.writeBigUInt64LE(minTokensOut, 8);
  data.writeBigUInt64LE(solLamports, 16);

  const ixBuy = new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: getGlobalPDA(),          isSigner: false, isWritable: false },
      { pubkey: feeRecipient,            isSigner: false, isWritable: true  },
      { pubkey: mint,                    isSigner: false, isWritable: false },
      { pubkey: state.pda,               isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve,  isSigner: false, isWritable: true  },
      { pubkey: associatedUser,          isSigner: false, isWritable: true  },
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: SYS_PROGRAM,             isSigner: false, isWritable: false },
      { pubkey: mintProgram,             isSigner: false, isWritable: false },
      { pubkey: creatorVault,            isSigner: false, isWritable: true  },
      { pubkey: getEventAuthorityPDA(),  isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM,            isSigner: false, isWritable: false },
    ],
    data,
  });

  return { instructions: [ixAta, ixBuy], expectedTokens: tokensOut, minTokensOut };
}

async function buildSellIx(mintStr, tokenAmount) {
  const mint = new PublicKey(mintStr);
  const state = await getBondingCurveState(mintStr);
  if (!state) throw new Error("bonding curve not found");
  if (state.complete) throw new Error("token graduated - sell on raydium");

  const mintProgram = await getMintProgram(mintStr);
  const feeRecipient = await getFeeRecipient();
  const creatorVault = getCreatorVaultPDA(state.creator);
  const associatedBondingCurve = await getAssociatedTokenAddress(mint, state.pda, true, mintProgram);
  const associatedUser = await getAssociatedTokenAddress(mint, wallet.publicKey, false, mintProgram);

  const solOut = (tokenAmount * state.virtualSolReserves) / (state.virtualTokenReserves + tokenAmount);
  const solOutAfterFee = solOut * 99n / 100n;
  const minSolOut = solOutAfterFee * BigInt(Math.floor((1 - SLIPPAGE_SELL) * 100)) / 100n;

  const data = Buffer.alloc(24);
  SELL_DISC.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(minSolOut, 16);

  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: getGlobalPDA(),          isSigner: false, isWritable: false },
      { pubkey: feeRecipient,            isSigner: false, isWritable: true  },
      { pubkey: mint,                    isSigner: false, isWritable: false },
      { pubkey: state.pda,               isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve,  isSigner: false, isWritable: true  },
      { pubkey: associatedUser,          isSigner: false, isWritable: true  },
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: SYS_PROGRAM,             isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mintProgram,             isSigner: false, isWritable: false },
      { pubkey: creatorVault,            isSigner: false, isWritable: true  },
      { pubkey: getEventAuthorityPDA(),  isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM,            isSigner: false, isWritable: false },
    ],
    data,
  });
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
      if (e.message.includes("block height exceeded") || e.message.includes("expired")) {
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ============ BUY / SELL ============
async function buy(mintStr, solAmount) {
  const { instructions } = await buildBuyIx(mintStr, solAmount);
  return sendIx(instructions);
}

async function buyWithRetry(mintStr, solAmount) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await buy(mintStr, solAmount);
    } catch (e) {
      lastErr = e;
      console.error(`buy attempt ${i+1}: ${e.message}`);
      if (e.message.includes("bonding curve not found") || e.message.includes("account not found")) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (e.message.includes("custom program error") || e.message.includes("account")) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function sellAll(mintStr) {
  const mint = new PublicKey(mintStr);
  const mintProgram = await getMintProgram(mintStr);
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, mintProgram);
  let info;
  try {
    info = await connection.getTokenAccountBalance(ata);
  } catch (e) {
    throw new Error(`no ATA: ${e.message}`);
  }
  const raw = BigInt(info.value.amount);
  if (raw === 0n) throw new Error("no token balance");
  const ix = await buildSellIx(mintStr, raw);
  return sendIx([ix]);
}

async function sellAllWithRetry(mintStr) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await sellAll(mintStr);
    } catch (e) {
      lastErr = e;
      console.error(`sell attempt ${i+1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function getTokenHoldings() {
  const holdings = [];
  for (const progId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: progId });
      for (const acc of accounts.value) {
        const info = acc.account.data.parsed.info;
        if (info.tokenAmount.uiAmount > 0) holdings.push({ mint: info.mint, amount: info.tokenAmount.uiAmount });
      }
    } catch {}
  }
  return holdings;
}

// ============ ANALYZER (full on-chain) ============
async function getHolderConcentration(mint, supply) {
  const holders = await getLargestHolders(mint);
  if (!holders.length || supply <= 0) return { top10: 100, top20: 100, count: 0 };
  const amounts = holders.map(h => parseInt(h.amount)).sort((a, b) => b - a);
  const top10 = amounts.slice(0, 10).reduce((a, b) => a + b, 0) / supply * 100;
  const top20 = amounts.slice(0, 20).reduce((a, b) => a + b, 0) / supply * 100;
  return { top10: +top10.toFixed(1), top20: +top20.toFixed(1), count: holders.length };
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
    const [concentration, state, activity, mintAuth, freezeAuth] = await Promise.all([
      getHolderConcentration(mint, supply),
      getBondingCurveState(mint),
      getTokenActivity(mint),
      getMintAuthority(mint),
      getFreezeAuthority(mint),
    ]);

    if (!state) return { score: 0, reason: `no bonding curve` };
    if (state.complete) return { score: 0, reason: `graduated` };

    const liqSol = Number(state.virtualSolReserves) / 1e9;
    const raisedSol = Number(state.realSolReserves) / 1e9;

    if (liqSol < MIN_LIQ_SOL) return { score: 0, reason: `liq ${liqSol.toFixed(1)} < ${MIN_LIQ_SOL}` };
    if (liqSol > MAX_LIQ_SOL) return { score: 0, reason: `graduated (liq ${liqSol.toFixed(0)} > ${MAX_LIQ_SOL})` };
    if (freezeAuth) return { score: 0, reason: `freeze authority aktif` };
    if (concentration.top10 > 90) return { score: 0, reason: `top10 ${concentration.top10}% > 90%` };

    if (activity.ageHours != null && activity.ageHours > MAX_AGE_HOURS) {
      return { score: 0, reason: `umur ${fmtAge(activity.ageHours)} > ${MAX_AGE_HOURS}j` };
    }

    const scores = {};

    if (concentration.top10 < 30) scores.holders = 100;
    else if (concentration.top10 < 45) scores.holders = 80;
    else if (concentration.top10 < 60) scores.holders = 50;
    else scores.holders = 20;

    if (liqSol > 80) scores.liquidity = 100;
    else if (liqSol > 50) scores.liquidity = 80;
    else if (liqSol > 30) scores.liquidity = 60;
    else scores.liquidity = 40;

    if (activity.txCount5m > 50) scores.activity = 100;
    else if (activity.txCount5m > 20) scores.activity = 80;
    else if (activity.txCount5m > 5) scores.activity = 50;
    else if (activity.txCount5m > 0) scores.activity = 30;
    else scores.activity = 0;

    if (raisedSol > 60) scores.raised = 100;
    else if (raisedSol > 30) scores.raised = 80;
    else if (raisedSol > 10) scores.raised = 60;
    else if (raisedSol > 3) scores.raised = 40;
    else scores.raised = 20;

    scores.authority = mintAuth ? 50 : 100;

    if (concentration.count > 60) scores.holders_count = 100;
    else if (concentration.count > 30) scores.holders_count = 80;
    else if (concentration.count > 10) scores.holders_count = 50;
    else scores.holders_count = 20;

    const total =
      scores.holders * 0.20 +
      scores.liquidity * 0.15 +
      scores.activity * 0.25 +
      scores.raised * 0.15 +
      scores.authority * 0.10 +
      scores.holders_count * 0.15;

    return {
      score: +total.toFixed(1),
      reason: `age ${fmtAge(activity.ageHours)} tx5m ${activity.txCount5m} raised ${raisedSol.toFixed(1)}S top10 ${concentration.top10}% liq ${liqSol.toFixed(0)} auth ${mintAuth ? "ada" : "revoked"}`,
    };
  } catch (e) {
    return { score: 0, reason: `analyze error: ${e.message}` };
  }
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

        const state = await getBondingCurveState(mint);
        if (state?.complete) {
          console.log(`[${mint.slice(0,8)}] graduated, forced sell attempt`);
          try { await sellAllWithRetry(mint); } catch (e) { console.error("forced sell failed:", e.message); }
          delete POSITIONS[mint]; savePositions();
          continue;
        }

        let reason = null, trail = 0;
        if (pos.peakPnlPct >= 100) trail = 25;
        else if (pos.peakPnlPct >= 80) trail = 20;
        else if (pos.peakPnlPct >= 60) trail = 15;
        else if (pos.peakPnlPct >= 40) trail = 10;
        else if (pos.peakPnlPct >= 20) trail = 5;

        if (pnl.pnlPct <= -15) reason = "CUT LOSS";
        else if (trail > 0 && pnl.pnlPct <= (pos.peakPnlPct - trail)) reason = "TRAILING";

        if (reason) {
          const sig = await sellAllWithRetry(mint);
          delete POSITIONS[mint]; savePositions();
          if (CHAT_ID) {
            const emoji = pnl.pnlSol >= 0 ? "🟢" : "🔴";
            await bot.telegram.sendMessage(CHAT_ID,
              `${emoji} *HARD ${reason}* ${mint.slice(0, 8)}\n` +
              `PnL: ${pnl.pnlPct}% (${fmtPnl(pnl.pnlSol)})\n` +
              `tx: \`${sig}\``,
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
const processedMints = new Map();
const MINT_COOLDOWN = 5 * 60 * 1000;
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
    const candidates = [...new Set(postBalances.map(b => b.mint).filter(Boolean))]
      .filter(m => m !== WSOL_MINT && m !== USDC_MINT);

    if (!candidates.length) return;

    let mint = null;
    for (const c of candidates) {
      const last = processedMints.get(c) || 0;
      if (now - last < MINT_COOLDOWN) continue;
      if (await isPumpToken(c)) { mint = c; processedMints.set(c, now); break; }
    }
    if (!mint) return;

    const res = await analyze({ mint });
    if (res.score > 0 || res.reason.startsWith("age") || res.reason.startsWith("tx5m")) {
      console.log(`analyze ${mint.slice(0,8)}: skor ${res.score} | ${res.reason} | pot ${buyAmount.toFixed(4)} SOL (${fmtIdr(buyAmount)})`);
    }

    if (res.score >= SCORE_THRESHOLD) {
      const sig = await buyWithRetry(mint, buyAmount);
      const price = await getCurrentPrice(mint);
      POSITIONS[mint] = { entrySol: buyAmount, entryPrice: price, tokenAmount: buyAmount / price, peakPnlPct: 0, tx: sig };
      savePositions();
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID,
        `🔥 *BUY* \`${mint.slice(0, 8)}\`\n` +
        `Amount: *${buyAmount.toFixed(4)} SOL (~${fmtIdr(buyAmount)})*\n` +
        `Skor: ${res.score}\n` +
        `${res.reason}\n` +
        `tx: \`${sig}\``,
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
function welcomeText() {
  const rate = Math.round(priceCache.solUsd * priceCache.usdIdr);
  return (
    "📈 *LANOX TRADING MEME COIN* 📈\n\n" +
    `💱 Rate: 1 SOL ≈ *Rp ${rate.toLocaleString('id-ID')}*\n` +
    `⏱️ Filter umur: max *${MAX_AGE_HOURS} jam*\n` +
    "🔍 Data: *full on-chain*\n" +
    "🤖 Status: *Siap Beraksi*\n" +
    "💰 Mode: Hard Mode Compounding\n" +
    "⚡ Jaringan: Solana (Pump.fun)\n\n" +
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
    `🔥 *HARD MODE (COMPOUNDING)* 🔥\n\n` +
    `Status: ${status}\n` +
    `Max Koin: ${currentMaxCoins()}\n` +
    `Score Min: ${SCORE_THRESHOLD}\n` +
    `Umur Max: ${MAX_AGE_HOURS} jam\n` +
    `Slippage: ${(SLIPPAGE_BUY*100).toFixed(0)}%/${(SLIPPAGE_SELL*100).toFixed(0)}%\n` +
    `Circuit: -50%\n\n` +
    `Saldo: *${bal.toFixed(4)} SOL*\n` +
    `(~${fmtIdr(bal)})`
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
            const sig = await sendIx([ix]);
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
      try { await sellAllWithRetry(h.mint); delete POSITIONS[h.mint]; ok++; } catch { fail++; }
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
      if (pnl) {
        text += `- \`${h.mint.slice(0,6)}\` : ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}%\n`;
        text += `  ${fmtPnl(pnl.pnlSol)}\n`;
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
  try { await ctx.answerCbQuery("Jual..."); await sellAllWithRetry(mint); delete POSITIONS[mint]; savePositions(); await ctx.reply(`✅ sold \`${mint.slice(0,8)}\``, { parse_mode: "Markdown" }); }
  catch (e) { await ctx.reply(`❌ gagal: ${e.message}`); }
});

bot.action("wallet", async ctx => {
  try {
    const bal = await getRawBalance();
    const text =
      `📊 *WALLET BOT*\n\n` +
      `SOL: *${bal.toFixed(4)}*\n` +
      `IDR: *${fmtIdr(bal)}*\n\n` +
      `addr: \`${wallet.publicKey.toBase58()}\``;
    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ menu", "menu")]]));
  } catch (e) { try { await ctx.answerCbQuery("❌ " + e.message, { show_alert: true }); } catch {} }
});

// ============ LAPORAN 10 MENIT ============
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
          posLines += `  • \`${h.mint.slice(0, 6)}\` ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct}% (${fmtPnl(pnl.pnlSol)})\n`;
        } else {
          posLines += `  • \`${h.mint.slice(0, 6)}\` —\n`;
        }
      }

      const status = hardMode.active ? "🟢 ON" : "🔴 OFF";
      const text =
        `📊 *LAPORAN ${REPORT_MINUTES} MENIT*\n\n` +
        `Status: ${status}\n` +
        `Saldo: *${rawBal.toFixed(4)} SOL* (~${fmtIdr(rawBal)})\n` +
        `Safe: ${safeBal.toFixed(4)} SOL\n` +
        `Posisi: ${holdings.length}/${currentMaxCoins()}\n` +
        `PnL terbuka: *${fmtPnl(totalPnlSol)}*\n\n` +
        (posLines ? `*Detail:*\n${posLines}` : `_Tidak ada posisi terbuka._`);

      await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" });
    } catch (e) { console.error("reportLoop error:", e.message); }
  }
}

// ============ RATE LOOP ============
async function rateLoop() {
  await updatePrices();
  while (true) {
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    await updatePrices();
  }
}

// ============ GUARDS ============
process.on("unhandledRejection", r => console.error("⚠️ Unhandled:", r?.message || r));
process.on("uncaughtException", e => console.error("⚠️ Uncaught:", e?.message || e));

hardModeLoop().catch(e => console.error("loop crashed:", e.message));
reportLoop().catch(e => console.error("report crashed:", e.message));
rateLoop().catch(e => console.error("rate crashed:", e.message));
bot.catch((err, ctx) => console.error(`Telegraf ${ctx?.updateType}:`, err.message));
bot.launch();
console.log("📈 LANOX BOT RUNNING — ATA AUTO + TOKEN-2022 + ON-CHAIN 📈");
