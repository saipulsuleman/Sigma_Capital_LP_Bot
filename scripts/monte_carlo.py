"""
Sigma Capital LP Bot -- Monte Carlo Simulation
===============================================
Simulates 30-day bot operation across N runs using GBM price dynamics.
Matches fee logic from services/paperTrading.js and circuit breaker
logic from utils/circuitBreaker.js.

Usage:
    pip install numpy
    python scripts/monte_carlo.py
"""

import json
import math
import os
import sys

import numpy as np

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(REPO_ROOT, "user-config.json")

try:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        user_config = json.load(f)
except FileNotFoundError:
    print("[WARN] user-config.json not found, using defaults")
    user_config = {}

CB = user_config.get("circuitBreaker", {})
MAX_DAILY_LOSS_USD  = CB.get("maxDailyLossUsd", 5)
MAX_CONSEC_LOSSES   = CB.get("maxConsecutiveLosses", 3)
MAX_WEEKLY_LOSS_USD = CB.get("maxWeeklyLossUsd", 25)
MAX_DRAWDOWN_PCT    = CB.get("maxDrawdownPct", 20)

HYBRID         = user_config.get("hybridScreening", {})
MIN_FEE_MEME   = HYBRID.get("meme",   {}).get("minFeeActiveTvlRatio", 2.0)
MIN_FEE_STABLE = HYBRID.get("stable", {}).get("minFeeActiveTvlRatio", 1.0)

DEPLOY_SOL    = float(user_config.get("deployAmountSol", 1.0))
MAX_POSITIONS = int(user_config.get("maxPositions", 3))
BINS_BELOW    = int(user_config.get("defaultBinsBelow", 69))
BIN_STEP_MIN  = float(user_config.get("minBinStep", 80))
BIN_STEP_MAX  = float(user_config.get("maxBinStep", 125))

SOL_PRICE_USD = 145.0
IDR_PER_USD   = 16_200
GAS_SOL       = 0.003    # approx deploy+close gas (live mode only)
DAYS          = 30
N_RUNS        = 10_000
SEED          = 42

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

SCENARIOS = {
    "Conservative (sigma=200%, fee borderline)": {
        "sigma_meme_lo":     1.2,
        "sigma_meme_hi":     3.0,
        "sigma_stable_lo":   0.10,
        "sigma_stable_hi":   0.40,
        "log_fee_mu_meme":   math.log(2.5),
        "log_fee_sd_meme":   0.7,
        "log_fee_mu_stable": math.log(1.2),
        "log_fee_sd_stable": 0.5,
        "meme_pct":          0.70,
        "positions_lambda":  3.5,
    },
    "Base (sigma=120%, fee>=2%/24h)": {
        "sigma_meme_lo":     0.6,
        "sigma_meme_hi":     2.4,
        "sigma_stable_lo":   0.075,
        "sigma_stable_hi":   0.30,
        "log_fee_mu_meme":   math.log(3.0),
        "log_fee_sd_meme":   0.8,
        "log_fee_mu_stable": math.log(1.5),
        "log_fee_sd_stable": 0.5,
        "meme_pct":          0.60,
        "positions_lambda":  4.5,
    },
    "Optimistic (sigma=80%, fee 5%+/24h)": {
        "sigma_meme_lo":     0.4,
        "sigma_meme_hi":     1.2,
        "sigma_stable_lo":   0.05,
        "sigma_stable_hi":   0.20,
        "log_fee_mu_meme":   math.log(5.0),
        "log_fee_sd_meme":   0.6,
        "log_fee_mu_stable": math.log(2.5),
        "log_fee_sd_stable": 0.4,
        "meme_pct":          0.50,
        "positions_lambda":  6.0,
    },
}

# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------

def sample_time_in_range(sigma_daily, bins_below, bin_step_bps, rng):
    """
    Sample hours-in-range before price hits the lower OOR barrier.

    Uses GBM first-passage-time approximation:
        log_barrier = bins_below * log(1 + bin_step/10000)  [magnitude]
        E[tau] = log_barrier^2 / sigma_hourly^2
        tau ~ Exponential(E[tau])
    """
    sigma_hourly = sigma_daily / math.sqrt(24.0)
    log_barrier  = bins_below * math.log(1.0 + bin_step_bps / 10_000.0)
    expected_h   = max(0.25, (log_barrier ** 2) / (sigma_hourly ** 2))
    hours        = float(rng.exponential(expected_h))
    return float(np.clip(hours, 0.25, 24.0 * 7))


def sample_pool(sc, rng):
    """Return (fee_rate_24h_pct, sigma_daily) for a randomly selected pool."""
    is_meme = rng.random() < sc["meme_pct"]
    if is_meme:
        sigma = rng.uniform(sc["sigma_meme_lo"],   sc["sigma_meme_hi"])
        fee   = float(rng.lognormal(sc["log_fee_mu_meme"],   sc["log_fee_sd_meme"]))
        fee   = max(fee, MIN_FEE_MEME)
    else:
        sigma = rng.uniform(sc["sigma_stable_lo"], sc["sigma_stable_hi"])
        fee   = float(rng.lognormal(sc["log_fee_mu_stable"], sc["log_fee_sd_stable"]))
        fee   = max(fee, MIN_FEE_STABLE)
    return min(fee, 50.0), sigma


# ---------------------------------------------------------------------------
# Single run
# ---------------------------------------------------------------------------

def simulate_run(sc, rng):
    capital_sol     = 5.0
    peak_sol        = capital_sol
    circuit_day     = None

    daily_loss_usd  = 0.0
    consec_losses   = 0
    rolling_7d_usd  = 0.0
    rolling_7d_epoch = 0

    pnls_usd = []

    for day in range(DAYS):
        daily_loss_usd = 0.0   # reset each UTC midnight

        n_opens = int(rng.poisson(sc["positions_lambda"]))
        for _ in range(n_opens):
            if circuit_day is not None:
                break

            fee_rate_24h, sigma_daily = sample_pool(sc, rng)
            bin_step = float(rng.uniform(BIN_STEP_MIN, BIN_STEP_MAX))
            hours    = sample_time_in_range(sigma_daily, BINS_BELOW, bin_step, rng)

            hourly_rate = fee_rate_24h / 100.0 / 24.0
            pnl_sol     = DEPLOY_SOL * hourly_rate * hours - GAS_SOL
            pnl_usd     = pnl_sol * SOL_PRICE_USD

            capital_sol += pnl_sol
            pnls_usd.append(pnl_usd)

            # circuit breaker state -- mirrors circuitBreaker.js logic
            if pnl_usd < 0:
                abs_loss        = abs(pnl_usd)
                daily_loss_usd += abs_loss
                consec_losses  += 1
                if (day - rolling_7d_epoch) > 7:
                    rolling_7d_usd   = abs_loss
                    rolling_7d_epoch = day
                else:
                    rolling_7d_usd  += abs_loss
            else:
                consec_losses = 0

            if capital_sol > peak_sol:
                peak_sol = capital_sol

            drawdown_pct = (
                (peak_sol - capital_sol) / peak_sol * 100.0 if peak_sol > 0 else 0.0
            )

            if (daily_loss_usd  >= MAX_DAILY_LOSS_USD  or
                    consec_losses   >= MAX_CONSEC_LOSSES   or
                    rolling_7d_usd  >= MAX_WEEKLY_LOSS_USD or
                    drawdown_pct    >= MAX_DRAWDOWN_PCT):
                circuit_day = day
                break

    n    = len(pnls_usd)
    wins = sum(1 for p in pnls_usd if p > 0)

    return {
        "pnl_usd":           (capital_sol - 5.0) * SOL_PRICE_USD,
        "n_positions":       n,
        "win_rate":          wins / n if n > 0 else 0.0,
        "circuit_triggered": circuit_day is not None,
        "circuit_day":       circuit_day if circuit_day is not None else DAYS,
        "max_drawdown":      (peak_sol - capital_sol) / peak_sol * 100.0 if peak_sol > 0 else 0.0,
    }

# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------

def run_scenario(name, sc):
    rng     = np.random.default_rng(SEED)
    results = [simulate_run(sc, rng) for _ in range(N_RUNS)]

    pnls   = np.array([r["pnl_usd"]           for r in results])
    wins   = np.array([r["win_rate"]           for r in results])
    circ   = np.array([r["circuit_triggered"]  for r in results], dtype=bool)
    cdays  = np.array([r["circuit_day"]        for r in results])
    n_pos  = np.array([r["n_positions"]        for r in results])
    ddowns = np.array([r["max_drawdown"]       for r in results])

    std_pnl    = float(np.std(pnls))
    mean_pnl   = float(np.mean(pnls))
    sharpe_mc  = (mean_pnl / std_pnl) * math.sqrt(12) if std_pnl > 0 else 0.0
    mean_wr    = float(np.mean(wins))
    p_circuit  = float(np.mean(circ))
    mean_cd    = float(np.mean(cdays[circ])) if circ.any() else DAYS

    return {
        "name":          name,
        "mean_pnl_usd":  mean_pnl,
        "mean_pnl_idr":  mean_pnl * IDR_PER_USD,
        "pct5_usd":      float(np.percentile(pnls, 5)),
        "pct25_usd":     float(np.percentile(pnls, 25)),
        "pct75_usd":     float(np.percentile(pnls, 75)),
        "sharpe_mc":     sharpe_mc,
        "win_rate":      mean_wr,
        "p_circuit":     p_circuit,
        "mean_circ_day": mean_cd,
        "mean_positions":float(np.mean(n_pos)),
        "mean_drawdown": float(np.mean(ddowns)),
        "t25_wr":  "LIKELY PASS" if mean_wr  >= 0.50 else "LIKELY FAIL",
        "t25_sh":  "LIKELY PASS" if sharpe_mc >= 0.50 else "LIKELY FAIL",
    }

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def print_report(all_stats):
    SEP  = "=" * 65
    LINE = "-" * 57

    print()
    print(SEP)
    print("  SIGMA CAPITAL LP BOT - MONTE CARLO SIMULATION")
    print(f"  Runs: {N_RUNS:,} | Horizon: {DAYS} hari | Capital: 5.0 SOL")
    print(f"  Circuit: daily>=${MAX_DAILY_LOSS_USD}, consec>={MAX_CONSEC_LOSSES},"
          f" weekly>=${MAX_WEEKLY_LOSS_USD}, dd>={MAX_DRAWDOWN_PCT}%")
    print(SEP)

    for s in all_stats:
        sign = "+" if s["mean_pnl_usd"] >= 0 else ""
        print()
        print(f"  [{s['name']}]")
        print("  " + LINE)
        print(f"  Mean PnL/bulan    : {sign}${s['mean_pnl_usd']:>8.2f}"
              f"  |  Rp {s['mean_pnl_idr']:>13,.0f}")
        print(f"  25th-75th pct     :  ${s['pct25_usd']:>7.2f}  ..  ${s['pct75_usd']:.2f}")
        print(f"  5th pct (VaR 95%) :  ${s['pct5_usd']:>7.2f}")
        print(f"  Sharpe (monthly)  :  {s['sharpe_mc']:>6.2f}    [T25 target: >=0.50]")
        print(f"  Win Rate          :  {s['win_rate']:>6.1%}    [T25 target: >=50%]")
        print(f"  P(circuit/30d)    :  {s['p_circuit']:>6.1%}")
        if s["p_circuit"] > 0:
            print(f"  Avg circuit day   :  {s['mean_circ_day']:>5.1f}")
        print(f"  Mean pos/bulan    :  {s['mean_positions']:>5.1f}")
        print(f"  Mean max drawdown :  {s['mean_drawdown']:>5.1f}%")
        print()
        print("  T25 PREDICTION:")
        print(f"    paper_win_rate >=50%  :  {s['t25_wr']}")
        print(f"    sharpe_mc >=0.50      :  {s['t25_sh']}")

    print()
    print(SEP)
    print("  CATATAN MODEL:")
    print("  * Gas (0.003 SOL) hanya relevan saat live; DRY_RUN tidak ada gas")
    print("  * Tumbling 7d window -- blind spot $4.99/day masih ada walaupun kecil")
    print("  * Fee rate setelah screening: min 2%/24h meme, 1%/24h stable")
    print("  * sigma meme sangat tinggi -> waktu in-range umumnya 2-8 jam")
    print("  * Rug pulls / liquidity drain TIDAK diperhitungkan dalam model ini")
    print(SEP)
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"\nConfig : {CONFIG_PATH}")
    print(f"Params : deploy={DEPLOY_SOL} SOL, bins={BINS_BELOW},"
          f" step={BIN_STEP_MIN:.0f}-{BIN_STEP_MAX:.0f}bps")
    print(f"Runs   : {N_RUNS:,} per scenario ...\n")

    all_stats = []
    for name, sc in SCENARIOS.items():
        sys.stdout.write(f"  Simulating [{name}] ... ")
        sys.stdout.flush()
        stats = run_scenario(name, sc)
        all_stats.append(stats)
        print("done")

    print_report(all_stats)
