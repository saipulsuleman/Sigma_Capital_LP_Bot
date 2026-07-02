# AGENTS.md — Sigma Capital LP Bot (handoff untuk Codex / agen mana pun)

> File ini dibaca otomatis oleh Codex CLI. Isinya = konteks kerja terkini yang
> sebelumnya hanya tersimpan di memory Claude Code (yang TIDAK ikut pindah).
> Spec produk lengkap ada di `CLAUDE.md`. Ringkasan operasional ada di sini.

## Apa ini
Bot LP otomatis untuk Meteora DLMM (Solana), single-sided (`bins_above=0`, SOL
tidak dikonversi paksa saat harga naik). Node.js + DeepSeek (agent SCREENER +
MANAGER), state di SQLite (`db/sigma.db`), dijalankan via **pm2** (proses
`sigma-capital`). Notifikasi Telegram.

## ATURAN MUTLAK
- **`DRY_RUN=true` WAJIB** sampai sertifikasi T25 ALL PASS. Tidak ada trading uang
  nyata. Semua sekarang paper trading. Jangan pernah set `DRY_RUN=false` tanpa
  perintah eksplisit user + T25 lulus.
- Bot baca flag dari **`process.env.DRY_RUN`**, bukan dari config file.

## Cara jalanin / pantau
```bash
pm2 list                              # cek proses sigma-capital
pm2 restart sigma-capital --update-env # restart setelah ubah config/.env
pm2 logs sigma-capital                # lihat log cycle
DRY_RUN=true node _cert_check.mjs     # status 6 kriteria T25
DRY_RUN=true node _paper_audit.mjs    # NET PnL paper (after gas+slippage+IL) + win-rate
```

## Skrip diagnostik lokal (prefix `_` = untracked/lokal)
- `_cert_check.mjs` — status T25 (paper_win_rate, sharpe, devnet, jest, dll).
- `_paper_audit.mjs` — audit posisi paper NET realistis + proyeksi oor_down vs max_hold.
- `scripts/pool_availability.mjs` — probe pool +EV yang tersedia sekarang.
- `scripts/autotune.mjs` — Monte Carlo bins_below (model bin-offset dasar backtest).

## Bukti profitabilitas — backtest historis (kerja utama sesi terakhir)
Tujuan: buktikan/patahkan profit terhadap DATA NYATA sebelum risiko SOL.
Sumber data: **GeckoTerminal OHLCV** (gratis, tanpa API key):
`https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/hour?aggregate=1&limit=1000`

Skrip (committed di `scripts/`):
- `backtest_historical_v2.mjs` — universe luas (`discoverPools` kedua slot),
  multi-entry (tiap 24h), fee DECAY (fee = baseline × clamp(volume_jam/rata2, 0, 3)).
  Persisten di `data/backtest_v2_store.json` (upsert key `poolAddr:entryTs`,
  idempotent → jalankan tiap hari untuk akumulasi pool).
- `backtest_range_sweep.mjs` — A/B bins_below {12..140} pada data sama.

**TEMUAN KUNCI (validated):** WIDE range menang, bukan narrow. Sweep menunjukkan
lebih lebar = win-rate & net naik monoton; **optimum ~bb 100-120**. Narrow (12-20)
bencana (posisi ke-knockout <8 jam sebelum fee menutup biaya). Pembeda menang/kalah
= **TIME-IN-RANGE (survival)**, bukan fee rate — dan lebar = cara membeli survival.
Fee tetap penting via GATE (hanya pool fee-tinggi yang "mampu" range sangat lebar).

**PERUBAHAN DITERAPKAN (2026-06-30):** `user-config.json` → `defaultBinsBelow` 64→**110**,
`maxBinsBelow` 69→**120** (min tetap 40, IL gate `maxBreakEvenHours=150` tetap).
Bot sudah restart & mulai deploy posisi bb~100-120 di paper. Win-rate paper naik
konsisten (20% → 41% selama beberapa hari) seiring posisi range-lebar matang.

## Bug yang sudah diperbaiki (jangan ulangi)
- Fee model v2 sempat MELEDAK (+777 SOL palsu) karena `feePerVol` tak dibatasi →
  diperbaiki jadi baseline × clamp(...,0,3).
- Fee model v2 sempat MELEDAK (+777 SOL palsu) karena `feePerVol` tak dibatasi →
  sudah diperbaiki jadi baseline × clamp(...,0,3).
- **max_hold zero-IL gap SUDAH DITUTUP (diverifikasi 2026-07-02).** `simulatedExitCosts`
  hanya menghitung IL untuk exit yang membawa bin di bawah entry. Jalur paper live
  menutup gap ini di `updatePaperPositions` (`paperTrading.js` ~baris 220-230): posisi
  max_hold yang berakhir DI BAWAH entry dibukukan sebagai `oor_down:bin=currentBin` →
  `closePaperPosition` → `simulatedExitCosts` membebankan IL. `backtest_historical_v2.mjs`
  (cabang max_hold di `replayEntry`, ~baris 116-127) dan `backtest_range_sweep.mjs` juga
  sudah membebankan IL di offset akhir. Jadi win-rate T25 TIDAK optimistik dari gap ini.
  Satu-satunya jalur yang membukukan plain max_hold adalah catch-block saat fetch bin
  GAGAL (`paperTrading.js` ~baris 237) — wajar, karena tak ada harga live untuk mark-to-market.

## Pekerjaan tersisa (prioritas)
1. **Akumulasi backtest ≥20 pool / ≥100 posisi** — jalankan `backtest_historical_v2.mjs`
   di hari-hari berbeda; universe berotasi, store menumpuk. Verdict baru sah setelah
   bar terpenuhi DAN net gate-pass tetap + saat pool teratas di-drop (uji robustness
   sudah ada di skrip).
2. **T25 `paper_win_rate` → ≥50%** (sekarang ~41%, naik konsisten). Kriteria lain sudah PASS.
3. Sebelum go-live: tinjau `maxPositions` (sekarang tinggi utk akumulasi data paper)
   vs kapital nyata.
4. **Sebelum go-live: cap ukuran compound.** Fitur compound (`index.js` ~baris 827:
   `deployAmount = baseAmount + pending_compound_sol`) melipat `simulated_fee_sol`
   terakumulasi (5 close oor_down) ke posisi berikutnya. Di DRY_RUN cek saldo di-skip →
   posisi bisa membengkak tak terbatas (contoh nyata: 3.19 & 3.70 SOL, digelembungkan
   fee meme simulasi 235%/321% yang tak realistis). BUKAN bug (compound sesuai desain) &
   TIDAK mengkorupsi win-rate (gate berbasis jumlah, bukan ukuran). Tapi untuk uang nyata,
   clamp `deployAmount` ke cap per-posisi (mis. `maxSolPerPosition`) yang ditentukan dari
   modal nyata. Live sudah punya jaring pengaman cek saldo wallet (F2), cap ini refinement.
5. (Opsional) Tambah unit test di `tests/` yang menegaskan max_hold-di-bawah-entry
   membebankan IL — mengunci perilaku yang sudah benar agar tak regresi.

## Catatan Codex vs Claude Code
- Ada hook Claude-Code bernama **GateGuard** ("Fact-Forcing Gate") yang memblokir
  Bash pertama tiap sesi sampai kamu print (1) permintaan user, (2) fungsi command.
  Ini hook lokal ECC; kemungkinan TIDAK aktif di Codex. Kalau muncul, cukup print
  2 fakta itu lalu ulangi command.
- Memory strategis lengkap dulu ada di `~/.claude/projects/E--Proyek-Akhir/memory/`
  (project_backtest_profit_proof, project_il_range_strategy, project_screener_selection,
  reference_diagnostic_scripts). Intinya sudah diringkas di file ini.
