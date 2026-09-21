# GlobalFolkGames BS — Demo Catalogue

**Status: PLANNING ONLY. No demo is built yet.**

This folder holds small, playable demos that prove **GlobalFolkGames BS works for a given game
genre**. Each demo exists to answer one question a game developer will ask:

> "Gasless and cheap sounds good, but does it actually work for MY kind of game?"

A board-game demo answers that for nobody in the web3 top charts. A runner demo answers it for
casual games. An idle demo answers it for idle games. **One demo per popular genre is the sales
argument**, and each one is also the reference a developer copies.

The main live rail demo is **GlobalFolkGames itself** (Ludo). These are the extra proofs.

---

## 1. Why this catalogue exists (the honest reasoning)

The web3 games charts (DappRadar, top 50 by activity) are dominated by **RPG/MMORPG**, **idle**,
**PvP arena/PvP card** and **casual**. Traditional board games are almost absent. So:

- Using **Ludo** to pitch a PvP studio, an MMORPG studio or an idle studio does not land. They cannot
  see themselves in a folk board.
- Using a demo **in their own genre** does land: "here is a live, gasless idle game on Arc, and the
  rail under it is what your game plugs into."

That is the whole purpose of this folder.

---

## 2. Genre popularity (web3, from the live DappRadar top 50, 2026-09)

| # | Genre | Real examples in the top 50 | Why it matters for GFG-BS | Demo priority |
|---|---|---|---|---|
| 1 | **RPG / MMORPG / MMO strategy** | Pixels, World of Dypians, Nine Chronicles, SERAPH, Heroes of Mavia, Medieval Empires | Long sessions, thousands of actions, persistent worlds. The biggest gas saving of all. | **HIGH** |
| 2 | **Idle / clicker / farming** | COIN by XYO, PlayMining, Sweat Economy, Lingo, Bomb Crypto | Constant actions; a per-action fee model destroys it. GFG-BS is the ideal fit. | **HIGHEST (cheapest to build)** |
| 3 | **PvP / battle arena / card** | Arena of Faith, Battle Bulls, Crypto Gladiator, Pantheon TCG, Clashub | Skill + money. Needs a game verifier for fair disputes. | **HIGH** |
| 4 | **Casual / hyper-casual** | Arc8 by GAMEE, FlappyMoonbird, Solscape, Bowled.io | Easiest to build, largest audience, simplest way to show the rail. | **HIGHEST (fastest to build)** |
| 5 | **Sports / racing / management** | MetaSoccer, Race Kingdom, Football Fun, ZTX | Seasonal sessions; many small actions. | MEDIUM |
| 6 | **Metaverse / sandbox / virtual world** | Upland, Wilder World, Victoria VR, Sinverse, Artyfact | Land, buildings, assets. The strongest proof that the rail is truly generic (not a board). | **HIGH (best genericness proof)** |
| 7 | **Trading card / collectible** | Pantheon TCG, Voxies, Aavegotchi | Needs the asset rails before it is a fair demo. | LATER |
| 8 | **Board / traditional / folk** | Rare in web3 | **GlobalFolkGames' differentiation.** The rail serves it; the charts do not. | LIVE (GFG Ludo) |

---

## 3. Demos, in build order

Each demo is a folder here with its own README, its own adapter, and one clear "what this proves".

### Built
_(none yet)_

### Next
| Folder | Genre | What it proves | Notes |
|---|---|---|---|
| `idle-farm/` | Idle / clicker | A player performing hundreds of actions per session costs the sponsor nothing inside the session. | Cheapest to build; tiny state loop. Strongest fit for the rail. |
| `endless-runner/` | Casual | A fast, arcade game is fully on-rail: randomness for spawns, score as the value rail. | **Graphics are already settled**: the owner forked `github.com/solomonfoskaay/rork-subway-surfers-clone` (pure web2/iOS). We port the ART and game feel to a plain web canvas; we do not inherit its architecture. |
| `arena-1v1/` | PvP | Two real players, seat authority enforced, a dispute resolved by the game verifier. | The pitch demo for PvP studios. |
| `tiny-mmo/` | MMORPG-lite | Many participants in ONE session, shared world state, persistence across sessions. | The pitch demo for MMORPG studios; also proves participant count is open, not 2. |
| `land-grid/` | Metaverse-ish | Plots, buildings and ownership treated as opaque state the rail never inspects. | The clearest proof of "the rail knows nothing about your game". |

### Ludo
The real game (GlobalFolkGames) is the live proof of the rail for board/traditional games. It is
not duplicated here; it lives in the main app and plugs into the same rail.

---

## 4. What every demo must have

1. **Playable in a plain browser**, mobile-first, no app store, no install.
2. **Zero gas for the player**, zero wallet popups.
3. **The rail visibly in use**: open a session, act freely, settle once, show the on-chain proof.
4. **A small `adapter.js`** (roughly 50 lines) that shows a developer exactly how little it takes to
   plug their own game in. The adapter is the real deliverable of every demo.
5. **A README** stating: the genre, what it proves, the adapter surface, and the cost measured.

---

## 5. Where the demos are served

**Now (solo dev, one repo):** served from a **path** on the existing domain, not a subdomain. No DNS
work, no extra certificates, one deploy, and a link you can put in a grant application immediately.
The exact path is decided when the first demo lands.

**Later (when GlobalFolkGames BS becomes its own repo):** move to its own subdomain then, not before.

---

## 6. Build order and the one-demo-at-a-time rule

Demos are **not built all at once**. Each is a small, complete, working thing, and each is finished
(playable + measured + documented) before the next starts. The order above starts with the two
cheapest and most convincing: **idle** and **casual (runner)**.

Per the project rules: building a demo is a decision, not a default. The owner approves each demo
before it starts.
