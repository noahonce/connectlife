# ConnectLife

A town that grows every time you connect for real.

ConnectLife turns reaching out to people into a game. You get different types of social quests, and
when you finish one, you write about how it went. Completing quests earns coins,
and coins build your town.

**Play it here:** https://noahonce.github.io/connectlife/

## How it works

**Quests.** Three at a time, drawn from 21 quests. Each one can appear at three
different lengths — "take a walk with a friend" might be 15 minutes, 30 minutes
or an hour — paying 20, 25 or 30 coins. At onboarding you pick the moods that
tend to pull you toward the habit you're working on (stress, boredom, loneliness
and so on), and quests matching those come up first. Quests recycle after a
two-day cooldown, so the game doesn't run out.

**Writing.** Finishing a quest means writing at least 75 words about it. Every
entry is kept in a journal you can read back — a record of every time you
reached out.

**Your town.** Coins buy structures, being a bench, a garden, a fountain, a beach, a
sports court, a party hall. Some of them attract a new neighbour into town, who
moves into their own house and will tell you what brought them. You can walk
around, talk to villagers, sit on benches, and go inside the town hall, the
party hall and your own home — which you can furnish and paint.

## Running it locally

No build step and no dependencies to install. Either open `index.html` directly,
or serve the folder:

```
python3 -m http.server 8000
```

Then visit http://localhost:8000

## Built with

Plain HTML, CSS and JavaScript — no frameworks. All 3D is
[three.js](https://threejs.org/), and every model in the game (characters,
buildings, furniture, trees) is built from primitives in code rather than
imported from model files. Saves are stored in the browser's local storage.


I hope you enjoy this game and that it brings you peace and healing.
