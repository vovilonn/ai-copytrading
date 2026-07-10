I have everything needed. Complete file read (all 788 lines including the `x-dc` script), design CLAUDE.md, README, fonts, and icon roster verified. Here is the inventory.

---

# Frontend inventory — Admin.dc.html (verified against source, 788 lines)

Single-file DC prototype. One `Component extends DCLogic` holds all state; `renderVals()` (lines 506–783) computes every bound value. It is an SPA with client-side `view` switching — no URL routing in the prototype (must be added). All data is mocked inline (lines 564–601).

## 1. Screens / routes / states

| View (`state.view`) | Gate | Route to build | Breadcrumbs | Empty state in proto |
|---|---|---|---|---|
| **Login** | `isLogin = !authed` (full-screen, replaces app) | `/login` | — | n/a |
| **Channels list** | `isChannels` (`view==='channels'`) | `/channels` | `Telegram Channels` (current) | ❌ none |
| **Channel detail** | `isChannel` (`view==='channel'`) | `/channels/:id` | `Telegram Channels` → `{name}` (1st clickable) | — |
| ↳ tab Messages | `isMsgTab` (`tab==='messages'`) | `/channels/:id/messages` | " | ❌ none |
| ↳ tab Settings | `isSettingsTab` (`tab==='settings'`) | `/channels/:id/settings` | " | n/a |
| **Actions** | `isActions` (`view==='actions'`) | `/actions` | `Actions` (current) | ✅ `emptyStyle` "No actions match the selected filters." |
| **Positions** | `isPositions` (`view==='positions'`) | `/positions` | `Positions` (current) | ✅ `posEmptyStyle` "No positions match the selected filters." |

Auth: `login()` (line 501) sets `authed=true` if both fields non-empty, else `loginErr`. `logout()` resets to `view:'channels'`, clears password. No real auth — mock only. `onPassKey` submits on Enter.

**Sidebar** (246px, hidden <820px): logo block + section label "Overview" + 3 nav buttons (Channels/Actions/Positions) + bottom **Settings button with NO onClick handler** (lines 101–104, gap). Nav active state: Channels stays active for BOTH `channels` and `channel` views (`inChannels`, line 721).

**Topbar** (60px): breadcrumbs (left) + Logout button (right). Breadcrumbs from `crumbs` (lines 724–728), 14px, separator `/` color `#3a3a40`.

**Bottom nav** (mobile, `display:none` → flex <820px, `padding-bottom:92px` on main): 3 items Channels/Actions/Positions, active color `#ff6a1f`, inactive `#6b6b70`.

Responsive breakpoints: **820px** (sidebar→bottomnav, table cards horizontal scroll), **640px** (filter rows stack, search full-width), **480px** (tighter padding). Note: CSS rule `[data-m="parsertext"]` (line 30) has **no matching element** in template — dead rule.

## 2. Per-screen fields / interactions

**Channels list table** (`min-width:820px`, 8 cols + chevron):
| Col | width | source | render |
|---|---|---|---|
| Channel | 24% | `initial` avatar + `name` + `handle` (mono) | — |
| Copy | 12% | `copyLabel` On/Off | green badge if enabled else grey |
| Win Rate | 11% | `winRate` string | tabular-nums |
| Actions | 10% | `actionCount` | bold |
| Active Positions | 10% | `activePos` | green badge if >0 |
| Messages | 11% | `msgCount` | — |
| Trade size | 12% | `$`+`tradeSize` (mono) | from settings |
| Max lev | 12% | `maxLev`+`x` (mono) | from settings |
| chevron | 44px | `chevron-right` | — |
- **Whole row clickable** → `c.open` → `open(id)` → channel detail, Messages tab.

**Channel detail header**: avatar `initial`, `name`, `handle · {msgCount} messages · {actionCount} actions`, status dot (green glow if Active) + `status`. Tabs: Messages / Settings.

**Messages timeline** (`max-width:720px`, vertical line at left:15px): per message node —
- Node tile: has actions → `#161618` tile w/ icon (single action → that action icon; multiple → `layers`); no actions → bare `#3a3a40` dot.
- `time` (mono), `text` (`white-space:pre-line`), optional photo (`img` or dashed placeholder w/ `image` icon + `photoLabel`).
- Result box (if actions): per `actionRows` — icon + `title`(+` · pct`) + `pair` (mono) + **Trade ref pill** (`ar.tradeRefOn` → `goTrade(ref)`) OR **Skipped** amber badge (shown when channel `enabled===false`). Then AI summary row (`sparkles` + `summaryText`) only if `method==='ai'`.
- Note row (no actions but has summary): `sparkles` + summary.

**Settings form** (`max-width:620px` card): 5 rows —
1. Copy trading — toggle (`enabled`)
2. Trade size — `$` prefix number input (`tradeSize`)
3. Max leverage — number input + `x` suffix (`maxLev`)
4. Default leverage · optional — number input + `x`, placeholder `—` (`defLev`)
5. Allow cross margin — toggle (`cross`)
- Footer: **Save changes** button + "Saved" flash (`circle-check`, 1800ms via `saveSettings`).

**Actions screen filters** (`data-m="filters"`):
- Channel: segmented, `[All channels] + 5 channels` — filters by `c.id`.
- Period: `All/Today/7d/30d` — **⚠ `fPeriod` is NEVER applied** in filter logic (lines 634–637). Dead filter / bug.
- Type: `All/Open/Close/Partial TP/Partial close`.
- Side: `All/LONG/SHORT`.
- Search "Search by pair…" — matches `act.pair` only.

**Actions table** (`min-width:860px`): Action (icon tile + `short` + dir label) · Pair (mono) · Summary (`detail`) · Trade (pill → `goTrade`) · Channel (initial tile + name, click → `open(ch.id)`) · Time (mono) · Method (`AI parsing` orange / `Auto parsing` grey).

**Positions screen**: 4 stat cards (`posStats`, grid `minmax(190px,1fr)`) + filters + table.
- Stat cards: Open positions / Unrealised PnL (colored) / Position value / Margin used. **⚠ Computed from `posRaw` (unfiltered)** — totals ignore active filters (lines 690–698).
- Filters: Channel (by **name**, not id — inconsistent w/ Actions) · Side `All/LONG/SHORT` · Margin `All/Cross/Isolated` · Search "Symbol, channel or #TR-ID…" (matches `symbol+source+tradeRef`).
- Table (`min-width:940px`, `table-layout:fixed`): Symbol(12%,mono) · Side(10%, icon+label) · Size(11%,mono) · Entry(9%) · Mark(9%) · Liq.(9%) · Unreal.PnL(11%, `pnl`+`roi` stacked colored) · TP/SL(10%, green TP / red SL stacked) · Leverage(11%, `lev`+margin chip) · Source(14%, channel name click→`open channel` + `tradeRef` mono).

**`goTrade(ref)` (line 504)** — central cross-nav: sets `view:'positions', fPosQuery:ref` and resets `fPosChannel/fPosSide/fPosMargin` to `'all'`. Triggered from timeline action pills AND Actions-table Trade pills. Prefills Positions search with `#TR-xxxx`. (Note: `p.tradeOn` line 687 also sets `fPosQuery` but is unwired in template — dead.)

## 3. Design tokens (dark-only)

Fonts: **Exo 2** variable TTF present at `uploads/Exo_2/Exo2-VariableFont_wght.ttf` + `-Italic-` (weights 100–900), plus 18 static weights in `static/`. Mono is **system stack only** (`ui-monospace,Menlo,monospace`) — **no mono font bundled** (use JetBrains Mono / IBM Plex Mono or keep system).

| CSS var | Value | Usage |
|---|---|---|
| `--bg` | `#000000` | app/page background |
| `--surface` | `#0d0d0f` | cards, tables, login card, panels |
| `--surface-2` | `#161618` | timeline node tile (active) |
| `--surface-img` | `#0a0a0c` | photo bg w/ image |
| `--fg` | `#f5f5f5` | body text |
| `--fg-strong` | `#fafafa` | headings, values |
| `--fg-1` | `#e4e4e7` | message text, search input text |
| `--fg-2` | `#d4d4d8` | trade-ref pill text |
| `--fg-3` | `#c9c9cf` | mono values, avatar initial |
| `--muted` | `#a1a1aa` | secondary values, logout |
| `--muted-2` | `#9a9aa0` | AI summary text |
| `--muted-3` | `#8a8a90` | labels, inactive seg, sublabels |
| `--dim` | `#6b6b70` | descriptions, th labels, placeholders |
| `--dim-2` | `#5a5a60` | handles, timestamps, sub |
| `--faint` | `#4a4a50` | section header, chevron |
| `--faint-2` | `#3a3a40` | crumb separator, empty dot |
| `--accent` | `#ff6a1f` | brand orange, toggles-on, tab underline, primary btn |
| `--accent-hover` | `#ff8a4d` | hover, AI accent, links hover |
| `--on-accent` | `#0a0a0a` | text on orange buttons |
| `--green` | `#34d399` | long / profit / on / TP |
| `--red` | `#fb7185` | short / loss / SL / error |
| `--amber` | `#fbbf24` | Skipped badge |
| `--border` | `rgba(255,255,255,.07)` | card/nav borders (also .06 .08 .09 .10 .12 .14 variants) |
| `--hover` | `rgba(255,255,255,.04)` | inputs, seg container, hover fills (also .02 .025 .05 .06 .09) |
| `--green-bg` | `rgba(52,211,153,.13)` | On/active-pos badges |
| `--amber-bg` | `rgba(251,191,36,.13)` | Skipped badge |
| `--accent-bg` | `rgba(255,106,31,.12)` | trade-ref hover, selection .3 |
| `--glow-green` | `0 0 8px 0 rgba(52,211,153,.6)` | active status dot |

Radii: `2,3,4,5,6,7,8,9,10,11,12` px, `50%`. Map to Tailwind `rounded-{sm..2xl}` custom scale.
Font sizes (px): `10,10.5,11,11.5,12,12.5,13,13.5,14,14.5,15,18,19,22`. Weights: `300,500,600,700`. Line-heights: `1, 1.2, 1.5, 1.55, 1.6`. Letter-spacing: `-.02em`(h2), `-.01em`(logo), `.02em, .04em, .05em, .08em`.

**Tailwind/shadcn**: config `darkMode:'class'`, force `.dark` root always (dark-only, no light tokens exist — do NOT scaffold light theme). `fontFamily.sans:['Exo 2',...]`, `fontFamily.mono:['ui-monospace','Menlo',...]`. Put tokens as CSS vars in `@layer base :root`, map shadcn semantic vars: `--background:#000`, `--card:#0d0d0f`, `--primary:#ff6a1f`, `--primary-foreground:#0a0a0a`, `--border:rgba(255,255,255,.07)`, `--muted-foreground:#6b6b70`, `--destructive:#fb7185`. `@font-face` via `next/font` or self-host the TTF.

## 4. shadcn components

| Need | shadcn | Rationale |
|---|---|---|
| Data tables (Channels, Actions, Positions) | **Table** + TanStack Table | 3 tables, fixed layouts, sortable/filterable |
| Channel tabs | **Tabs** | Messages/Settings, matches `data-state` underline |
| Copy/Cross toggles | **Switch** | 42×24 track, restyle to orange |
| Text/number inputs | **Input** | login, trade size, lev, search (prefix/suffix wrappers custom) |
| Buttons | **Button** | primary orange + ghost/outline (logout, tabs) |
| Badges (Copy On/Off, Skipped, Active pos, count, margin chip) | **Badge** | variant-driven colored pills |
| Stat cards, panels | **Card** | 4 pos-stat cards + settings card |
| Save/error feedback, realtime alerts | **Sonner** (toast) | prototype uses inline "Saved" flash + `loginErr`; upgrade to toasts for WS errors, order-skip reasons |
| Login form | **Form** + zod | validation |
| Breadcrumbs | **Breadcrumb** | topbar trail |

**Hand-built (not shadcn):**
- **Segmented filter control** — 8 instances (Channel/Period/Type/Side/Margin). No shadcn primitive; build `<SegmentedControl>` (radiogroup a11y) matching `segBtn` style (active `rgba(255,255,255,.09)`).
- **Message timeline** — vertical-line + node-tile layout with per-action rows, AI-summary, photo. Fully bespoke.
- **Status dot with glow**, **avatar-initial tile** (deterministic bg), **trade-ref pill** — small custom atoms.
- **PnL/ROI stacked colored cell**, **TP/SL stacked cell** — custom cell renderers.

## 5. Lucide icons (exact `name=` set actually rendered)

`send`, `activity`, `coins`, `settings`, `log-out`, `chevron-right`, `image`, `sparkles`, `arrow-up-right`, `circle-check`, `search`, `trending-up`, `trending-down`, `circle-x`, `target`, `scissors`, `layers`.

Action-type→icon map (lines 509–516): `open`→`trending-up`/`trending-down` (by dir, NOT `circle-plus`); `close`→`circle-x`; `partial_tp`→`target`; `partial_close`→`scissors`; multi-action node→`layers`.

Defined in `lucide-icon.js` but **unused**: `chevron-left`, `circle-minus`, `shield`, and `circle-plus` (declared as `A.open.icon` but overridden by `openIco`). Add `alert-triangle`/`triangle-alert`, `clock`, `x`, `pause` when building the gaps below (not in current icon file).

## 6. Data model (TypeScript, exactly what renders)

```ts
type ChannelId = string;                 // 'c1'..; use TG channel id in prod
type TradeRef = string;                  // '#TR-1042'
type Side = 'long' | 'short';
type ActionType = 'open' | 'close' | 'partial_tp' | 'partial_close';
type ParseMethod = 'auto' | 'ai';        // auto=deterministic parser, ai=Claude

interface Channel {
  id: ChannelId;
  name: string;
  handle: string;                        // '@crypto_vip'
  initial: string;                       // avatar letter — FRONTEND-derived (name[0])
  status: 'Active' | 'Paused';           // BACKEND (userbot connection/enabled)
  winRate: string;                       // '68%' — BACKEND (closed trades)
  msgCount: number;                      // BACKEND
  actionCount: number;                   // BACKEND (Σ actions over messages)
  activePos: number;                     // BACKEND (open positions owned by channel)
  settings: ChannelSettings;
}

interface ChannelSettings {              // all BACKEND-persisted, editable in UI
  enabled: boolean;                      // "Copy trading"
  tradeSize: number;                     // fixed notional fallback ($)
  maxLev: number;                        // clamp ceiling
  defLev: number | '';                   // optional default leverage
  cross: boolean;                        // allow cross margin
}

interface MessageAction {
  type: ActionType;
  dir: Side;
  pair: string;                          // 'BTCUSDT'
  pct?: string;                          // '50%' (partials)
  tradeRef?: TradeRef;
}

interface Message {
  id: string;                            // proto has none — ADD (tg message id)
  time: string;                          // display 'Today, 14:32' — BACKEND format or FRONTEND from ts
  ts?: number;                           // ADD real epoch for sorting/realtime
  method: ParseMethod;
  text: string;
  photo?: boolean;
  img?: string | null;                   // media URL
  photoLabel?: string;
  summary?: string;                      // AI one-liner (only when method==='ai')
  actions: MessageAction[];              // [] = informational
}

interface ActionRow {                    // flattened Actions table (one row/action)
  action: MessageAction;
  channelId: ChannelId;
  channelName: string;
  channelInitial: string;
  time: string;
  method: ParseMethod;
  detail: string;                        // title(+ ' · pct') — FRONTEND from action
}

interface Position {                     // Bybit /v5/position/list — BACKEND
  symbol: string;
  side: Side;
  size: string;                          // '0.42 BTC' — FRONTEND format(qty+coin)
  entry: string; mark: string; liq: string;
  lev: number;
  marginMode: 'Cross' | 'Isolated';
  uPnl: number;                          // unrealised, live
  roi: string;                           // '+6.2%' — BACKEND or FRONTEND
  tp: string; sl: string;                // ladder → show nearest/last
  margin: number;                        // initial margin
  value: number;                         // notional
  source: string;                        // owning channel NAME (decision #1)
  tradeRef: TradeRef;                    // internal — needs Bybit↔trade map (orderLinkId)
}

interface PositionStats {                // FRONTEND-aggregated over all Positions
  openCount: number;
  unrealisedPnl: number;                 // Σ uPnl
  positionValue: number;                 // Σ value
  marginUsed: number;                    // Σ margin
}
```

Backend-computed: `status, winRate, msgCount, actionCount, activePos`, all `Position` numeric fields (from Bybit), parsed `actions/summary/method`, `tradeRef↔symbol` mapping. Frontend-computed/derived: `initial`, badge styles, `size/roi` formatting, `PositionStats` sums, filter results, `detail` string, colors.

## 7. Realtime contract (WS + TanStack Query)

Realtime surfaces: **(a)** Positions `mark/uPnl/roi/liq` "streams like Bybit"; **(b)** message timeline (new msg → new node, then parsed actions/summary arrive async after parser/AI); **(c)** channel counters (`msgCount/actionCount/activePos/winRate`); **(d)** global Actions table (new action). Backend proxies Bybit private WS (`position`) + public `tickers` for mark, plus our parser events.

**Server→client events** (own gateway, e.g. socket.io namespaces):
```ts
'positions.snapshot' { positions: Position[]; stats: PositionStats }   // on connect
'position.upsert'    { position: Position }                            // open/size/tp-sl change
'position.close'     { symbol: string; tradeRef: TradeRef }
'ticker.update'      { symbol: string; mark: string;                   // high-freq, throttled
                       uPnl?: number; roi?: string; liq?: string }
'message.new'        { channelId: ChannelId; message: Message }        // actions may be []
'message.parsed'     { channelId: ChannelId; messageId: string;
                       actions: MessageAction[]; method: ParseMethod; summary?: string }
'action.new'         { row: ActionRow }
'channel.stats'      { channelId: ChannelId;
                       msgCount: number; actionCount: number;
                       activePos: number; winRate?: string; status?: 'Active'|'Paused' }
'action.skipped'     { channelId; pair: string; reason: string }       // gap: needs_review/skip toast
'execution.mode'     { mode: 'dry_run' | 'live' }                      // gap: dry-run indicator
```

**Query keys & cache strategy:**
- `['positions']` → hydrate from `positions.snapshot`. On `ticker.update`/`position.upsert`: `queryClient.setQueryData` patch by `symbol` in place — **never invalidate** (avoid refetch on hot path). **Batch `ticker.update` via `requestAnimationFrame`/50–100ms throttle** (Bybit tickers fire many/sec). `PositionStats` recomputed client-side from patched array (fixes the prototype's unfiltered-totals issue; keep totals over full set, table over filtered set). `position.close` → remove row.
- `['channel', id, 'messages']` → on `message.new` prepend to page-0 (timeline is newest-first); on `message.parsed` patch that message's `actions/summary/method`.
- `['channels']` → on `channel.stats` patch the single channel row (`setQueryData`), no invalidate.
- `['actions', filters]` → on `action.new` prepend if it passes active filters, else ignore. Consider `staleTime:Infinity` + WS-driven updates.
- Settings mutations: **optimistic** `setQueryData(['channels'])` + PATCH; rollback on error; success = Sonner "Saved" (replaces the 1800ms flash).

## 8. Design gaps → minimal, "1:1-safe" solutions

1. **Sidebar Settings button has no handler** (l.101–104). → Route to `/settings` (global: EXECUTION_MODE display, API/env status, TG session status). Minimal: reuse existing button styling, add page. Or repurpose as global-settings modal.
2. **No pending-limit-orders screen** (decisions #6/#7 create limit orders w/ TTL). → Add a **"Pending" segmented filter** to Positions (or a Status column) surfacing `order/realtime` open limits with a TTL countdown (`clock` icon); reuses Positions table shell.
3. **No closed-trades history, but Win Rate column requires it** (l.142). → Add **History view** `/history` (4th nav item `list` or reuse) listing closed trades with realized PnL; Win Rate links to it. Minimal: same Table primitive, filters mirror Actions.
4. **No `Add`/доливка action type** (decision #6). → Per decision, render as **`open`** (`trending-up/down`) in same `#TR-x` — no new type needed; ensure parser emits `type:'open'` with same `tradeRef`. Optionally a subtle "add" sublabel.
5. **No dry-run indicator** (decision #3, EXECUTION_MODE). → Add a **global badge in topbar** (right of breadcrumbs, before Logout): amber pill "DRY-RUN" when `mode==='dry_run'`, hidden in live. Reuses badge tokens (`--amber` / `--amber-bg`). Per-channel Off already shown via "Skipped".
6. **No `needs_review` state** (AI-uncertain parses). → New Method value `'review'` → orange-amber "Needs review" badge in Actions Method column + timeline; add `triangle-alert` icon; drive via `action.skipped`/review event; toast on arrival.
7. **Period filter is dead** (`fPeriod` unused, l.708 vs filter l.634–637). → Wire it: filter `rows`/`actions` by `m.ts` against `today/7d/30d`. Requires adding real `ts` to `Message`.
8. **Positions stats ignore filters** (l.690–698 use `posRaw`). → Keep global totals as-is (intentional "across all channels") but label clearly; OR add filtered subtotal. Minimal: keep global, document.
9. **Channel filter key mismatch** — Actions filters by `id`, Positions by `name` (l.711 vs 714). → Standardize on `channelId` everywhere; map `Position.source` name→id at ingest.
10. **No message/position/trade IDs** in model → add stable ids for keys, dedupe, and realtime patching.
11. **Skipped has no reason** (decision #1 symbol-ownership, #4 no-SL, #7 out-of-range). → Extend Skipped badge with tooltip/`reason` string from backend (`action.skipped.reason`).

## 9. Win Rate & Active Positions computation

**Active Positions** (prototype l.602): `activeByChannel[channelName] = count of open positions where source===name`. Production: count `/v5/position/list` entries whose owning channel (symbol→channel via ownership map, decision #1) equals the channel. Realtime via `channel.stats`. Green badge when >0 (`--green-bg`), grey when 0.

**Win Rate** — **not derivable from prototype data** (no closed-trades dataset; `winRate` is a hardcoded string per channel, l.585–589). Backend must maintain closed trades with realized PnL: `winRate = closedWins / closedTrades` where a trade `#TR-x` is a "win" if its **net realized PnL > 0** at final close (aggregate partial TPs + close fills − fees per `tradeRef`). Needs the History store (gap #3) and a Bybit realized-PnL source (`/v5/position/closed-pnl` or execution stream). Display as `Math.round(rate*100)+'%'`. Until history exists, column shows `—`.

## 10. `apps/web` structure

```
apps/web/
  src/
    main.tsx                      // QueryClientProvider + RouterProvider + WS provider
    lib/queryClient.ts            // staleTime tuned per key; ws → setQueryData patchers
    lib/ws.ts                     // socket client; dispatch events → cache patchers (throttled tickers)
    routes/  (react-router v6 data router)
      _auth login.tsx             // /login (redirect if authed)
      _app                        // guarded layout: Sidebar + Topbar + <Outlet/> + BottomNav
        channels.tsx              // /channels (list)
        channel.$id.tsx           // /channels/:id → <Tabs> Messages|Settings
        actions.tsx               // /actions
        positions.tsx             // /positions?tr=#TR-xxxx  (goTrade → navigate w/ search param)
        history.tsx  settings.tsx // gaps #3, #1
    components/
      layout/{Sidebar,Topbar,BottomNav,Breadcrumbs}.tsx
      ui/… (shadcn)               // table,tabs,switch,input,button,badge,card,sonner,breadcrumb,form
      SegmentedControl.tsx        // hand-built (§4)
      MessageTimeline.tsx  TimelineNode.tsx
      PnlCell.tsx StatusDot.tsx AvatarInitial.tsx TradeRefPill.tsx SkippedBadge.tsx DryRunBadge.tsx
      tables/{ChannelsTable,ActionsTable,PositionsTable}.tsx  // TanStack Table
    features/
      channels/{queries,mutations,useChannelSettings}.ts
      positions/{queries,usePositionsStream}.ts
      actions/queries.ts
```
- **Routing**: react-router v6 data router; `goTrade` → `navigate('/positions?tr='+ref)`, Positions reads `?tr` into search filter (replaces prototype's `fPosQuery` state); breadcrumbs derive from route.
- **State**: server state = TanStack Query; filters = URL search params (`useSearchParams`) so they're shareable/back-button-safe (prototype keeps in component state). WS patches cache directly.
- **Forms**: Channel Settings via react-hook-form + zod; **optimistic** `setQueryData(['channels'])`, rollback in `onError`, Sonner success/error. Number coercion for tradeSize/maxLev/defLev; empty defLev → `undefined`.
- **Errors**: query `onError`→Sonner; WS reconnect w/ backoff + `positions.snapshot` re-hydrate; per-action skip reasons as inline badges + optional toast; global ErrorBoundary per route.

---

**Files referenced (absolute):**
- `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/design/project/Admin.dc.html` (source of truth, 788 lines)
- `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/design/project/lucide-icon.js` (21 icons defined; 3 unused)
- `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/design/project/CLAUDE.md` (icons = lucide-react only)
- `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/design/project/uploads/Exo_2/Exo2-VariableFont_wght.ttf` + `-Italic-` (+18 static in `static/`) — **Exo 2 present**; **no mono font bundled** (system stack).
- Test media: `uploads/test/{chart-btc,chart-sol,meme,news}.png`