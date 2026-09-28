// ConnectLife — client-side state + screen rendering.
// No frameworks: `state` holds everything, `render()` redraws the current screen.

const STORAGE_KEY = 'connectlife_state';

const defaultState = {
  screen: 'welcome',
  name: '',
  character: {
    skin: '#FFDFC0',
    eyes: 'almond',
    nose: 'button',
    hairStyle: 'crop',
    hairColor: '#6B4A32',
    outfit: '#3D5A80',
    glasses: 'none',
    facialHair: 'none',
  },
  triggers: [],
  villageName: '',
  characterTab: 'eyes',
  howItWorksIndex: 0,
  coins: 30,
  devMode: false,
  village: [],
  villagers: [],
  home: null,          // { items:[], wall, floor } — created on first visit by homeState()
  homePlacement: null,
  homeShopTab: 'buy',
  metNeighbors: {},
  questsShown: [],
  questTiers: {},   // questId -> 0|1|2, the duration tier rolled for it
  journal: [],      // one entry per completed quest, newest last
  activeJournalId: null,
  completedQuestIds: [],   // lifetime record: every quest ever finished, deduped
  questCompletedAt: {},    // questId -> epoch ms of the last completion, drives recycling
  startedQuestIds: [],
  activeQuestId: null,
  history: [],
  lastReward: null,
  selectedStructureId: null,
  hasOnboarded: false,
  villageIntroStep: 0,
  placement: null,
  villagePos: null,
};

let state = loadState();
// Saved state from before the real-3D character creator (old shape: face/
// hairColor/outfitColor/extra) can't drive the new one — reset it rather
// than crash on a missing field like state.character.eyes.
if (!state.character || !state.character.eyes) {
  state.character = { ...defaultState.character };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return { ...defaultState, ...saved };
  } catch (e) {}
  return { ...defaultState };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---- Dev mode --------------------------------------------------------
// Load the page as  ?dev=1  to turn it on and  ?dev=0  to turn it off. The
// choice is saved into state like anything else, so it survives ordinary
// reloads without having to keep the query string in the URL.
//
// What it does is narrow on purpose: nothing COSTS anything. Every
// structure reads as affordable and confirming one doesn't deduct. It
// deliberately does NOT hand out a big pile of coins and it doesn't touch
// how coins are earned, so switching it back off leaves a balance that
// still makes sense — you get back exactly the coins you'd legitimately
// have earned, rather than a save that has to be thrown away.
//
// Every coin check in the app goes through these three, so there's one
// place to look and no gate can quietly miss the flag.
function applyDevModeFromUrl() {
  const flag = new URLSearchParams(location.search).get('dev');
  if (flag === null) return;
  state.devMode = flag !== '0' && flag !== 'false';
  saveState();
}

function canAfford(cost) {
  return state.devMode || state.coins >= cost;
}

function spendCoins(cost) {
  if (!state.devMode) state.coins -= cost;
}

function coinsLabel() {
  return state.devMode ? '\u221E' : state.coins;
}

// An always-visible badge while the mode is on. The whole point of dev mode
// is that the economy is lying to you, so it should be impossible to forget
// it's running — otherwise a "why is this free?" bug hunt is inevitable.
function renderDevBadge() {
  const existing = document.getElementById('devBadge');
  if (!state.devMode) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  // The badge hangs off the phone frame, which only exists on the game page
  // itself — walk-demo.html and anything else that loads app.js just for
  // buildCharacter() has no frame to hang it on. Without this guard the
  // throw happens inside render() and takes the whole boot down with it.
  const frame = document.querySelector('.phone');
  if (!frame) return;
  const badge = document.createElement('div');
  badge.id = 'devBadge';
  badge.className = 'dev-badge';
  badge.title = 'Dev mode: structures are free. Reload with ?dev=0 to turn it off.';
  badge.textContent = 'DEV \u00B7 \u221E';
  frame.appendChild(badge);
}

function goTo(screen) {
  if (state.screen !== screen) {
    state.history.push(state.screen);
  }
  state.screen = screen;
  saveState();
  render();
}

function goBack() {
  if (!state.history.length) return;
  state.screen = state.history.pop();
  saveState();
  render();
}

function finishOnboarding() {
  state.hasOnboarded = true;
  goTo('quests');
}

function resetApp() {
  localStorage.removeItem(STORAGE_KEY);
  state = { ...defaultState };
  render();
}

// ---------- Screens ----------

function backButton() {
  return `<div class="txt soft tiny back-link" onclick="goBack()">← Back</div>`;
}

function screenWelcome() {
  return renderWelcomeScreen(false);
}

function screenReturningWelcome() {
  return renderWelcomeScreen(true);
}

function renderWelcomeScreen(returning) {
  const primaryLabel = returning ? `Go to ${escapeHtml(state.villageName)}` : "Let's get started";
  const primaryAction = returning ? "goTo('quests')" : "goTo('name')";
  return `
    <div class="screen welcome-screen">
      <div id="welcomeScene" class="welcome-scene"></div>
      <div class="welcome-overlay">
        <div class="welcome-title">ConnectLife</div>
        <div class="txt soft center" style="margin:6px 0 22px;">a town that grows<br>every time you connect for real</div>
        <button class="btn" style="width:80%;" onclick="${primaryAction}">${primaryLabel}</button>
      </div>
    </div>
  `;
}

// ---------- Welcome screen 3D grove ----------

let welcomeAnimId = null;
let welcomeRenderer = null;

function teardownWelcomeScene() {
  if (welcomeAnimId !== null) cancelAnimationFrame(welcomeAnimId);
  welcomeAnimId = null;
  if (welcomeRenderer) {
    welcomeRenderer.dispose();
    if (welcomeRenderer.forceContextLoss) welcomeRenderer.forceContextLoss();
    welcomeRenderer = null;
  }
}

function makeGroveTree(scene, x, z, scale) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.11, 0.5, 8),
    new THREE.MeshStandardMaterial({ color: 0x8B5E34, roughness: 0.9 })
  );
  trunk.position.y = 0.25;
  trunk.castShadow = true;
  g.add(trunk);

  const foliageColors = [0x4CAF6D, 0x5FC97D, 0x3E9E5C];
  const puffs = [
    { x: 0, z: 0, y: 0.86, r: 0.34 },
    { x: 0.22, z: 0.1, y: 0.72, r: 0.27 },
    { x: -0.21, z: 0.13, y: 0.7, r: 0.26 },
    { x: 0.02, z: -0.23, y: 0.76, r: 0.28 },
  ];
  puffs.forEach((p, i) => {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(p.r, 10, 8),
      new THREE.MeshStandardMaterial({ color: foliageColors[i % foliageColors.length], roughness: 0.8 })
    );
    puff.position.set(p.x, p.y, p.z);
    puff.castShadow = true;
    g.add(puff);
  });

  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  scene.add(g);
}

const WELCOME_SCENE_W = 341;
const WELCOME_SCENE_H = 658;

function initWelcomeScene() {
  teardownWelcomeScene();
  const holder = document.getElementById('welcomeScene');
  if (!holder || typeof THREE === 'undefined') return;
  const w = WELCOME_SCENE_W, h = WELCOME_SCENE_H;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xBEE7FB);

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  holder.appendChild(renderer.domElement);
  welcomeRenderer = renderer;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x4CAF6D, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d0, 1.25);
  sun.position.set(4, 8, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -6;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.CylinderGeometry(8, 8, 0.4, 48),
    new THREE.MeshStandardMaterial({ color: 0x6FCB6F, roughness: 0.95 })
  );
  ground.position.y = -0.2;
  ground.receiveShadow = true;
  scene.add(ground);

  const treeSpots = [
    [-1.1, -2.6, 0.9], [0.3, -2.8, 0.75], [1.3, -2.3, 0.8],
    [-1.7, -1.6, 0.95], [1.6, -1.4, 1.0], [0.0, -1.5, 0.6],
    [-0.7, -0.3, 0.75], [1.0, 0.0, 0.65], [-1.6, 0.6, 0.6],
    [-1.5, 1.3, 1.05], [1.5, 1.4, 0.9], [0.2, 1.2, 0.55],
    [-0.9, 2.3, 0.95], [0.9, 2.4, 0.85], [-0.1, 2.9, 0.7],
    [-1.6, 3.0, 0.65], [1.6, 2.8, 0.7],
  ];
  treeSpots.forEach(([x, z, scale]) => makeGroveTree(scene, x, z, scale));

  let angle = 0;
  function animate() {
    welcomeAnimId = requestAnimationFrame(animate);
    angle += 0.0018;
    camera.position.set(Math.sin(angle) * 2, 7, Math.cos(angle) * 2);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  animate();
}

// The name / character / triggers / town-name screens are reached two ways:
// once in order during onboarding, and again one at a time from Settings.
// hasOnboarded tells them apart on its own — Settings only exists after
// onboarding — so editing needs no extra state. In edit mode the screens drop
// their progress dots, change their copy, and hand control back to Settings
// instead of advancing to the next onboarding step.
function isEditingProfile() {
  return state.hasOnboarded;
}

function editDots(html) {
  return isEditingProfile() ? '' : html;
}

function screenName() {
  return `
    <div class="screen">
      ${backButton()}
      ${editDots('<div class="progress-dots"><span class="on"></span><span></span><span></span><span></span><span></span></div>')}
      <div class="txt" style="font-size:17px; margin-top:10px;">${isEditingProfile() ? 'What should we call you?' : 'Welcome to ConnectLife!<br>What should we call you?'}</div>
      <input type="text" id="nameInput" placeholder="Your name" value="${escapeHtml(state.name)}" />
      <div class="txt soft tiny">${isEditingProfile() ? 'Your villagers will start using this right away.' : 'No pressure — you can always change this in Settings'}</div>
      <div class="spacer"></div>
      <button class="btn" id="nameContinue" onclick="submitName()">${isEditingProfile() ? 'Save' : 'Continue'}</button>
    </div>
  `;
}

function submitName() {
  const val = document.getElementById('nameInput').value.trim();
  if (!val) return;
  state.name = val;
  saveState();
  if (isEditingProfile()) goBack();
  else goTo('character');
}

// ============================================================
// Character creator — option catalogs
// ============================================================
const SKIN_TONES = ['#FFDFC0', '#F5C69A', '#E0A374', '#B87B4E', '#8A5A34', '#5C3A22'];
const HAIR_COLORS = ['#2B2118','#6B4A32','#B8894A','#D9B24C','#8A2E2E','#3D5A80','#6B6B6B','#7C4A9E','#E8E8E8'];
const OUTFIT_COLORS = ['#3D5A80','#7C9473','#B3543F','#8A6D00','#5C4A9E','#2B7A78','#C2452B','#4A4A4A'];

const EYE_STYLES = [
  { id: 'round',  label: 'Round' },
  { id: 'almond', label: 'Almond' },
  { id: 'wide',   label: 'Wide' },
];
const NOSE_STYLES = [
  { id: 'button',  label: 'Button' },
  { id: 'point',   label: 'Point' },
  { id: 'wide',    label: 'Wide' },
];
const HAIR_STYLES = [
  { id: 'bald',   label: 'Bald' },
  { id: 'crop',   label: 'Crop' },
  { id: 'spiky',  label: 'Spiky' },
  { id: 'curly',  label: 'Curly' },
  { id: 'pony',   label: 'Ponytail' },
  { id: 'long',   label: 'Long' },
];
const GLASSES_STYLES = [
  { id: 'none',   label: 'None' },
  { id: 'round',  label: 'Round' },
  { id: 'square', label: 'Square' },
  { id: 'shades', label: 'Shades' },
];
const FACIAL_HAIR_STYLES = [
  { id: 'none',      label: 'None' },
  { id: 'mustache',  label: 'Mustache' },
  { id: 'goatee',    label: 'Goatee' },
  { id: 'beard',     label: 'Beard' },
  { id: 'full',      label: 'Full' },
];

// ---- Swatch icons — small SVGs depicting what each option actually looks
// like, instead of a letter/emoji. All use currentColor so they pick up
// the swatch's normal/selected text color automatically.
const NONE_ICON = `<svg viewBox="0 0 40 40"><line x1="11" y1="20" x2="29" y2="20" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.55"/></svg>`;

const EYE_ICONS = {
  round: `<svg viewBox="0 0 40 40"><ellipse cx="20" cy="20" rx="11" ry="9" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="20" cy="20" r="4.3" fill="currentColor"/></svg>`,
  almond: `<svg viewBox="0 0 40 40"><path d="M6 20 Q20 10 34 20 Q20 30 6 20 Z" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="22" cy="19" r="3.4" fill="currentColor"/></svg>`,
  wide: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="20" cy="20" r="6.3" fill="currentColor"/></svg>`,
};

const NOSE_ICONS = {
  button: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="6" fill="currentColor"/></svg>`,
  point: `<svg viewBox="0 0 40 40"><path d="M20 9 L28 27 Q20 32 12 27 Z" fill="currentColor"/></svg>`,
  wide: `<svg viewBox="0 0 40 40"><ellipse cx="20" cy="21" rx="11" ry="7" fill="currentColor"/></svg>`,
};

const GLASSES_ICONS = {
  none: NONE_ICON,
  round: `<svg viewBox="0 0 40 40"><circle cx="13" cy="20" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="27" cy="20" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="21" y1="20" x2="19" y2="20" stroke="currentColor" stroke-width="2.5"/><line x1="5" y1="19" x2="1" y2="16" stroke="currentColor" stroke-width="2"/><line x1="35" y1="19" x2="39" y2="16" stroke="currentColor" stroke-width="2"/></svg>`,
  square: `<svg viewBox="0 0 40 40"><rect x="4" y="13" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="22" y="13" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="18" y1="19" x2="22" y2="19" stroke="currentColor" stroke-width="2.5"/></svg>`,
  shades: `<svg viewBox="0 0 40 40"><rect x="4" y="14" width="14" height="11" rx="3.5" fill="currentColor"/><rect x="22" y="14" width="14" height="11" rx="3.5" fill="currentColor"/><line x1="18" y1="19" x2="22" y2="19" stroke="currentColor" stroke-width="2.5"/></svg>`,
};

const HEAD_ICON_OUTLINE = `<circle cx="20" cy="23" r="11" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.5"/>`;
const HAIR_CAP = `<path d="M9 21 Q9 9 20 9 Q31 9 31 21 Q26 15 20 15 Q14 15 9 21 Z" fill="currentColor"/>`;
const HAIR_ICONS = {
  bald: `<svg viewBox="0 0 40 40">${HEAD_ICON_OUTLINE}</svg>`,
  crop: `<svg viewBox="0 0 40 40">${HEAD_ICON_OUTLINE}${HAIR_CAP}</svg>`,
  spiky: `<svg viewBox="0 0 40 40">${HEAD_ICON_OUTLINE}
    <path d="M10 20 Q10 12 20 12 Q30 12 30 20 Q25 16 20 16 Q15 16 10 20 Z" fill="currentColor"/>
    <path d="M13 13 L15 4 L18 13 Z" fill="currentColor"/>
    <path d="M18 11 L20 2 L22 11 Z" fill="currentColor"/>
    <path d="M22 13 L25 4 L27 13 Z" fill="currentColor"/>
  </svg>`,
  curly: `<svg viewBox="0 0 40 40">${HEAD_ICON_OUTLINE}
    <circle cx="20" cy="10" r="6" fill="currentColor"/><circle cx="11" cy="15" r="5" fill="currentColor"/>
    <circle cx="29" cy="15" r="5" fill="currentColor"/><circle cx="15" cy="20" r="4.5" fill="currentColor"/>
    <circle cx="25" cy="20" r="4.5" fill="currentColor"/>
  </svg>`,
  pony: `<svg viewBox="0 0 40 40">${HEAD_ICON_OUTLINE}${HAIR_CAP}
    <path d="M30 18 Q38 20 34 29 Q29 24 28 19 Z" fill="currentColor"/>
  </svg>`,
  long: `<svg viewBox="0 0 40 40">${HEAD_ICON_OUTLINE}${HAIR_CAP}
    <path d="M9 20 Q6 29 9 35 Q13 30 11 20 Z" fill="currentColor"/>
    <path d="M31 20 Q34 29 31 35 Q27 30 29 20 Z" fill="currentColor"/>
  </svg>`,
};

const FACIAL_HAIR_ICONS = {
  none: NONE_ICON,
  mustache: `<svg viewBox="0 0 40 40"><path d="M6 22 Q13 15 20 22 Q27 15 34 22 Q27 19 20 24 Q13 19 6 22 Z" fill="currentColor"/></svg>`,
  goatee: `<svg viewBox="0 0 40 40">
    <circle cx="20" cy="17" r="10" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.5"/>
    <path d="M14 21 Q20 20 26 21 L25 23 Q20 24 15 23 Z" fill="currentColor"/>
    <path d="M15 25 Q20 35 25 25 Q22 29 20 29 Q18 29 15 25 Z" fill="currentColor"/>
  </svg>`,
  beard: `<svg viewBox="0 0 40 40">
    <circle cx="20" cy="17" r="10" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.5"/>
    <path d="M9 17 Q9 30 20 34 Q31 30 31 17 Q31 24 20 25 Q9 24 9 17 Z" fill="currentColor"/>
  </svg>`,
  full: `<svg viewBox="0 0 40 40">
    <circle cx="20" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.5"/>
    <path d="M8 19 Q13 13 20 19 Q27 13 32 19 Q27 17 20 21 Q13 17 8 19 Z" fill="currentColor"/>
    <path d="M9 21 Q9 32 20 36 Q31 32 31 21 Q31 27 20 28 Q9 27 9 21 Z" fill="currentColor"/>
  </svg>`,
};

const CHARACTER_TABS = [
  { id: 'eyes', label: 'Eyes' },
  { id: 'nose', label: 'Nose' },
  { id: 'glasses', label: 'Glasses' },
  { id: 'hair', label: 'Hair' },
  { id: 'facialHair', label: 'Facial Hair' },
  { id: 'skin', label: 'Skin' },
  { id: 'outfit', label: 'Outfit' },
];

// ---- Character creator — screen + swatch UI ----

function characterTabRowHTML() {
  return CHARACTER_TABS.map(t => `
    <div class="tab ${state.characterTab === t.id ? 'on' : ''}" onclick="setCharacterTab('${t.id}')">${t.label}</div>
  `).join('');
}

function characterSwatchGrid(options, field, iconMap) {
  return `<div class="swatch-grid">${options.map(o => `
    <div class="swatch ${state.character[field] === o.id ? 'on' : ''}" onclick="setCharacterOption('${field}','${o.id}')" title="${o.label}">${iconMap[o.id]}</div>
  `).join('')}</div>`;
}

function characterColorGrid(colors, field) {
  return `<div class="swatch-grid">${colors.map(c => `
    <div class="swatch ${state.character[field] === c ? 'on' : ''}" style="background:${c};" onclick="setCharacterOption('${field}','${c}')"></div>
  `).join('')}</div>`;
}

function characterPanelHTML() {
  const tab = state.characterTab;
  if (tab === 'eyes') return characterSwatchGrid(EYE_STYLES, 'eyes', EYE_ICONS);
  if (tab === 'nose') return characterSwatchGrid(NOSE_STYLES, 'nose', NOSE_ICONS);
  if (tab === 'glasses') return characterSwatchGrid(GLASSES_STYLES, 'glasses', GLASSES_ICONS);
  if (tab === 'hair') {
    return `<div class="section-label">Style</div>` + characterSwatchGrid(HAIR_STYLES, 'hairStyle', HAIR_ICONS) +
           `<div class="section-label">Color</div>` + characterColorGrid(HAIR_COLORS, 'hairColor');
  }
  if (tab === 'facialHair') {
    return characterSwatchGrid(FACIAL_HAIR_STYLES, 'facialHair', FACIAL_HAIR_ICONS) +
           `<div class="section-label">Uses your hair color</div>`;
  }
  if (tab === 'skin') return characterColorGrid(SKIN_TONES, 'skin');
  if (tab === 'outfit') return characterColorGrid(OUTFIT_COLORS, 'outfit');
  return '';
}

function screenCharacter() {
  return `
    <div class="screen">
      ${backButton()}
      ${editDots('<div class="progress-dots"><span class="on"></span><span class="on"></span><span></span><span></span><span></span></div>')}
      <div class="txt center" style="font-size:15px;">${isEditingProfile() ? 'Change your look' : "Let's make it yours"}</div>
      <div class="character-scene">
        <div id="characterCanvas"></div>
        <div class="scene-hint">drag to spin</div>
      </div>
      <div class="tab-row" id="charTabRow">${characterTabRowHTML()}</div>
      <div id="charPanel">${characterPanelHTML()}</div>
      <div class="spacer"></div>
      <button class="btn" onclick="${isEditingProfile() ? 'goBack()' : "goTo('triggers')"}">${isEditingProfile() ? 'Done' : 'Love it!'}</button>
    </div>
  `;
}

function setCharacterTab(tab) {
  state.characterTab = tab;
  saveState();
  document.getElementById('charTabRow').innerHTML = characterTabRowHTML();
  document.getElementById('charPanel').innerHTML = characterPanelHTML();
}

function setCharacterOption(field, value) {
  state.character[field] = value;
  saveState();
  document.getElementById('charPanel').innerHTML = characterPanelHTML();
  rebuildCharacterModel();
}

// ============================================================
// Character creator — real 3D model
// ============================================================
function mat(color, rough) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough === undefined ? 0.75 : rough });
}

// Builds a tapered cylinder stretched between two points — used for limbs.
function limbSegment(pA, pB, rTop, rBot, material, segments) {
  const dir = new THREE.Vector3().subVectors(pB, pA);
  const len = dir.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBot, len, segments || 28),
    material
  );
  mesh.position.copy(pA).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  mesh.castShadow = true;
  return mesh;
}

// Bakes a mesh's position/rotation into its own geometry (cloned, so the
// original mesh is untouched) and returns just the geometry — used to
// collect pieces for merging into one real single mesh, since a merged
// geometry only has one transform for the whole result.
function bakedGeometry(mesh) {
  mesh.updateMatrix();
  const geo = mesh.geometry.clone();
  geo.applyMatrix4(mesh.matrix);
  return geo;
}

// A shoe — a single simple rounded blob, Mii-style: no laces, no sole, no
// heel/toe detail, just a smooth shape in a shoe color. Slightly oversized
// relative to the (now much shorter) leg, which is what sells stubby chibi
// legs rather than just short ones.
function buildShoe(pos, shoeMat) {
  const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.19, 18, 14), shoeMat);
  shoe.scale.set(1, 0.62, 1.28);
  shoe.position.copy(pos);
  shoe.castShadow = true;
  return shoe;
}

// HEAD_SHRINK scales the head "skull" — the head sphere, ears, and hair —
// both their size and how far they sit from the head's center. It does NOT
// scale the facial features themselves (eyes, nose, mouth, glasses, facial
// hair): those keep their own absolute size, and only their attachment
// position scales, so the face stays readable at any head size.
// BODY_SCALE scales the torso/arms/legs as a unit.
//
// These two together set the whole silhouette. The pair below is tuned for
// deliberately chibi proportions — a big head on a short, chunky body, at
// roughly 2.3 heads tall — because the earlier, more realistic build (a
// small head at ~2.8 heads tall, with small eyes) landed squarely in the
// uncanny valley and read as unsettling rather than friendly. They're also
// chosen so the character's TOTAL height barely moves (2.62 → 2.59), which
// is what keeps every existing camera framing, ground shadow, and interior
// clamp valid without retuning any of them.
const HEAD_SHRINK = 0.92;
const BODY_SCALE = 1.05;

// Base (pre-scale) landmark heights, in the local space each group is built
// in. HEAD_LOCAL_Y is where the head sits in its own group — chosen so the
// bottom of the head sphere lands almost exactly on the group's origin,
// i.e. the origin IS the neck seam. BODY_NECK_TOP_LOCAL/BODY_FOOT_BOTTOM_LOCAL
// are read off the torso/neck/shoe geometry below.
const HEAD_LOCAL_Y = 0.6 * HEAD_SHRINK;
const BODY_NECK_TOP_LOCAL = 0.97;
const BODY_FOOT_BOTTOM_LOCAL = -0.408; // accounts for the shoe blob sitting below the foot point
const GROUND_Y = -1.18;
const FOOT_MARGIN = 0.05; // small gap so the ground shadow reads under the feet

// Where each facial feature sits, measured from the head's own center as a
// multiple of HEAD_SHRINK — so the whole face moves and re-spaces itself as
// one unit whenever the head size changes, instead of every add*() function
// carrying its own drifting magic numbers.
//
// The Y values put the eyes just BELOW the head's vertical midline with the
// nose and mouth close under them. That's the baby-schema layout every
// appealing cartoon face uses; the previous layout had the eyes above the
// midline with a lot of empty face beneath, which is the single biggest
// reason the old faces read as off.
//
// Each Z is how far forward the flat feature plane floats off the face, and
// is picked to sit just barely proud of the head sphere AT THAT FEATURE'S
// OWN HEIGHT — the sphere curves away as you go down the face, so the mouth
// needs a much smaller Z than the eyes. Getting this wrong is what made
// features look pasted in front of the head rather than on it.
const FACE_EYE_X = 0.225;
const FACE_EYE_Y = -0.03;
const FACE_BROW_Y = 0.125;
const FACE_NOSE_Y = -0.20;
const FACE_NOSE_Z = 0.575;
const FACE_MOUTH_Y = -0.36;
const FACE_MOUTH_Z = 0.505;
const FACE_GLASSES_Z = 0.63;

// The head's own shape, shared by the head mesh and by the placement math
// below so the two can never drift apart.
const HEAD_R = 0.62;
const HEAD_SCALE_Y = 0.98;
const HEAD_SCALE_Z = 0.95;

// How much of the head's curve an off-centre feature turns to follow. 0 =
// stays flat facing forward, 1 = lies flat against the skull. Partway is the
// usual compromise: enough that the feature settles onto the head instead of
// hovering beside it in three-quarter view, not so much that an eye turns
// away from the camera when the character is seen head-on.
const FACE_FOLLOW = 0.75;

// How far the head's surface sticks out (its Z) at a given point on the
// face, in HEAD_SHRINK units. 0 outside the head's own silhouette.
function headSurfaceZ(x, y) {
  const q = 1 - (x / HEAD_R) ** 2 - (y / (HEAD_R * HEAD_SCALE_Y)) ** 2;
  return q <= 0 ? 0 : HEAD_R * HEAD_SCALE_Z * Math.sqrt(q);
}

// Sticks a flat feature plane onto the face at (x, y) — measured from the
// head's centre in HEAD_SHRINK units — so that it clears the skull at every
// one of its own corners, and swivels it to partly follow the head's curve.
//
// A plane parked at a FIXED z is fine dead-centre and gets swallowed as it
// moves out toward the nose or the cheek, because the sphere bulges forward
// there. That is exactly what went wrong when the eyes were made twice as
// wide: their inner edge ended up 0.02 BEHIND the head's surface, the head
// drew over it, and 39% of each eye — the inner 39% — simply wasn't there.
// Both eyes rendered as half-moons.
//
// So rather than hand-tuning a z per feature (and silently re-breaking every
// one of them the next time the head's shape changes), this samples the
// head's real surface under the plane's own footprint and pushes the plane
// just past the worst point it finds. The corner samples are taken 8% wide
// to leave room for any small extra tilt the caller adds afterwards, e.g.
// the almond eye's rotation.z.
function placeOnFace(plane, side, x, y, planeW, planeH, headY, featR, gap) {
  const hw = (planeW / 2 / featR) * 1.08;
  const hh = (planeH / 2 / featR) * 1.08;
  const cx = side * x;
  const yaw = side * Math.asin(Math.min(1, Math.abs(x) / HEAD_R)) * FACE_FOLLOW;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  let cz = 0;
  [-hw, 0, hw].forEach((dx) => {
    [-hh, 0, hh].forEach((dy) => {
      // Where this corner lands once the plane is swivelled, and the centre
      // z that would put it `gap` clear of the skull there.
      cz = Math.max(cz, headSurfaceZ(cx + dx * cos, y + dy) + gap + dx * sin);
    });
  });
  plane.rotation.y = yaw;
  plane.position.set(cx * featR, headY + y * featR, cz * featR);
  return plane;
}
const EAR_X = 0.585;
const EAR_Y = -0.02;

function buildCharacter(cfg) {
  const g = new THREE.Group();
  const skinMat = mat(cfg.skin, 0.6);
  const outfitMat = mat(cfg.outfit);
  const shoeMat = mat('#3A2E22', 0.8);

  // ================= BODY =================
  // Mii-style: short, rounded, uniform capsule shapes for the torso, arms,
  // and legs — no tapering, no joints, no fingers or shoe details, and
  // almost no neck, matching the real Mii body plan.
  const bodyGroup = new THREE.Group();

  // Torso, arms, and legs are all outfit-colored, so instead of leaving
  // them as separate overlapping meshes, their geometries are collected
  // here and merged into one real single mesh below — genuinely one
  // piece, not just several pieces lined up to look like one.
  const trunkGeometries = [];

  // Torso — a short, rounded capsule.
  const torsoR = 0.4;
  const torsoBottomY = 0.38;
  const torsoTopY = 0.62;

  const torsoBody = new THREE.Mesh(
    new THREE.CylinderGeometry(torsoR, torsoR, torsoTopY - torsoBottomY, 32, 1, true),
    outfitMat
  );
  torsoBody.position.y = (torsoTopY + torsoBottomY) / 2;
  trunkGeometries.push(bakedGeometry(torsoBody));

  const torsoTopCap = new THREE.Mesh(
    new THREE.SphereGeometry(torsoR, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    outfitMat
  );
  torsoTopCap.position.y = torsoTopY;
  trunkGeometries.push(bakedGeometry(torsoTopCap));

  // Shoulders — an actual rounded cap on each side of the torso, at its
  // widest point, partly embedded in the torso dome so it reads as one
  // continuous shape (same trick as the hip-bottom ball the legs embed
  // into below). This is what the arms attach to, rather than meeting the
  // torso's own curve directly.
  const shoulderR = 0.23;
  const shoulderY = torsoTopY + 0.07;
  const shoulderX = 0.31;
  [-1, 1].forEach((side) => {
    const shoulderCap = new THREE.Mesh(new THREE.SphereGeometry(shoulderR, 24, 18), outfitMat);
    shoulderCap.position.set(side * shoulderX, shoulderY, 0.02);
    trunkGeometries.push(bakedGeometry(shoulderCap));
  });

  // Bottom is flat, not rounded, so it aligns cleanly with a waistline
  // (pants, a belt, etc.) instead of curving away from it.
  const torsoBottomCap = new THREE.Mesh(new THREE.CircleGeometry(torsoR, 32), outfitMat);
  torsoBottomCap.rotation.x = Math.PI / 2; // face downward
  torsoBottomCap.position.y = torsoBottomY;
  trunkGeometries.push(bakedGeometry(torsoBottomCap));

  // Hip/pelvis block — a whole separate lower-body piece whose top radius
  // is exactly torsoR, at exactly torsoBottomY, so its top lines up with
  // the torso's flat bottom perfectly (same shape, same place) — the
  // torso's own flat cap above doubles as this block's roof, so this
  // cylinder is left open at the top to avoid a redundant, z-fighting
  // second disc there. Its own bottom is rounded, for the legs to embed
  // into the same way they used to embed into the torso.
  const hipTopY = torsoBottomY;
  const hipBottomY = hipTopY - 0.13;
  const hipBottomR = 0.32;
  // How much the hip's rounded underside is flattened. At 1.0 it's a full
  // hemisphere, which hangs a whole hipBottomR below the block — and that
  // was the real reason the lower body read as one solid mass rather than
  // as two legs. The ball reached down to y = -0.100, well past where the
  // legs part, so it filled the crotch and the legs only became separate
  // shapes for the last 0.31 of their length (23% of body height). Squashing
  // it lifts the underside to y = +0.074 without making the hips look
  // chopped off flat.
  const HIP_CAP_SQUASH = 0.55;
  const hipBlock = new THREE.Mesh(
    new THREE.CylinderGeometry(torsoR, hipBottomR, hipTopY - hipBottomY, 32, 1, true),
    outfitMat
  );
  hipBlock.position.y = (hipTopY + hipBottomY) / 2;
  trunkGeometries.push(bakedGeometry(hipBlock));

  const hipBottomCap = new THREE.Mesh(
    new THREE.SphereGeometry(hipBottomR, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    outfitMat
  );
  hipBottomCap.position.y = hipBottomY;
  // bakedGeometry() composes position AND scale into the geometry, so this
  // squash survives the merge into the single trunk mesh.
  hipBottomCap.scale.set(1, HIP_CAP_SQUASH, 1);
  trunkGeometries.push(bakedGeometry(hipBottomCap));

  // neck — short, but extended enough at both ends to bury itself inside
  // the torso's shoulder dome below and the head sphere above, so it
  // reads as one continuous connection instead of a gap or a flat seam
  // meeting the head at a single point.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.24, 24), skinMat);
  neck.position.y = 1.02;
  neck.castShadow = true;
  bodyGroup.add(neck);

  // arms — one uniform rounded capsule per arm (sleeved in the shirt
  // color), embedded into the shoulder cap built above (its pivot sits
  // right at the cap's own center, same embedding trick as the legs into
  // the hip ball) so it reads as attached to an actual shoulder at the
  // player's side, not just sprouting from the torso's curve. They end in
  // a small rounded skin-toned cap flush with the arm's own width — not a
  // separate detached ball, not tapered to a point.
  //
  // Unlike the torso, each arm is its own Group pivoted at the shoulder
  // (not baked into the merged trunk mesh) so it can be rotated for a walk
  // cycle — see the "limbs" pose rig at the bottom of this function.
  const handR = 0.115;
  const armGroups = [];
  [-1, 1].forEach((side) => {
    const shoulder = new THREE.Vector3(side * shoulderX, shoulderY, 0.02);
    const hand = new THREE.Vector3(side * 0.47, 0.2, 0.08);
    const handLocal = hand.clone().sub(shoulder);
    const armGroup = new THREE.Group();
    armGroup.position.copy(shoulder);
    armGroup.add(limbSegment(new THREE.Vector3(), handLocal, 0.125, handR, outfitMat));
    const handMesh = new THREE.Mesh(new THREE.SphereGeometry(handR, 16, 14), skinMat);
    handMesh.position.copy(handLocal);
    handMesh.castShadow = true;
    armGroup.add(handMesh);
    bodyGroup.add(armGroup);
    armGroups.push(armGroup);
  });
  const [leftArm, rightArm] = armGroups;

  // legs — short, uniform rounded capsules (outfit-colored, like pants),
  // starting from inside the new hip block (not the torso itself) so they
  // meet it flush, ending in a simple rounded shoe blob. Each leg is its
  // own Group pivoted at the hip, same reasoning as the arms above.
  const legGroups = [];
  [-1, 1].forEach((side) => {
    // Stance widened and the legs slimmed a little: at the old numbers the
    // two legs were 0.010 apart at the hip, i.e. touching, so even below the
    // hip ball they merged into one shape.
    const hip = new THREE.Vector3(side * 0.2, hipBottomY + 0.05, 0.02);
    const foot = new THREE.Vector3(side * 0.25, -0.26, 0.05);
    const footLocal = foot.clone().sub(hip);
    const legGroup = new THREE.Group();
    legGroup.position.copy(hip);
    legGroup.add(limbSegment(new THREE.Vector3(), footLocal, 0.165, 0.15, outfitMat));
    const shoeLocal = new THREE.Vector3(side * 0.25, -0.29, 0.1).sub(hip);
    legGroup.add(buildShoe(shoeLocal, shoeMat));
    bodyGroup.add(legGroup);
    legGroups.push(legGroup);
  });
  const [leftLeg, rightLeg] = legGroups;

  const trunkMesh = new THREE.Mesh(
    THREE.BufferGeometryUtils.mergeBufferGeometries(trunkGeometries),
    outfitMat
  );
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;
  bodyGroup.add(trunkMesh);

  bodyGroup.scale.setScalar(BODY_SCALE);
  bodyGroup.position.y = (GROUND_Y + FOOT_MARGIN) - BODY_FOOT_BOTTOM_LOCAL * BODY_SCALE;
  g.add(bodyGroup);

  // ================= HEAD =================
  const headGroup = new THREE.Group();
  const headY = HEAD_LOCAL_Y;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD_R * HEAD_SHRINK, 48, 36),
    skinMat
  );
  head.position.y = headY;
  head.scale.set(1, HEAD_SCALE_Y, HEAD_SCALE_Z);
  head.castShadow = true;
  headGroup.add(head);

  // ears — fixed shape (not customizable); scale with the skull. Kept small
  // and tucked close in: they only clear the skull by a hair. Big ears
  // sticking off the side of the head were reading as goblin-ish, which is
  // the opposite of the friendly read this style wants.
  [-1, 1].forEach((side) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.125 * HEAD_SHRINK, 22, 18), skinMat);
    ear.position.set(side * EAR_X * HEAD_SHRINK, headY + EAR_Y * HEAD_SHRINK, 0);
    ear.scale.set(0.5, 1.0, 0.95);
    ear.castShadow = true;
    headGroup.add(ear);
  });

  // `feminine`/`bowColor` are NPC-only cfg keys — never set by the
  // character creator (see addEyes/addMouth/addHairBow) — so this changes
  // nothing about the player's own avatar, only hand-authored villagers.
  addEyes(headGroup, cfg.eyes, headY, HEAD_SHRINK, cfg.feminine);
  addBrows(headGroup, cfg.hairColor, headY, HEAD_SHRINK);
  addNose(headGroup, cfg.nose, headY, cfg.skin, HEAD_SHRINK);
  const mouth = addMouth(headGroup, headY, HEAD_SHRINK, cfg.feminine);
  addGlasses(headGroup, cfg.glasses, headY, HEAD_SHRINK);
  addHair(headGroup, cfg.hairStyle, cfg.hairColor, headY, HEAD_SHRINK);
  addFacialHair(headGroup, cfg.facialHair, cfg.hairColor, headY, HEAD_SHRINK);
  if (cfg.feminine) addHairBow(headGroup, cfg.bowColor || '#D64550', headY, HEAD_SHRINK);

  // No group-level scale here — the skull is already built at final size
  // above, and facial features below keep their own absolute size and only
  // have their attachment position pulled in by HEAD_SHRINK.
  headGroup.position.y = bodyGroup.position.y + BODY_NECK_TOP_LOCAL * BODY_SCALE;
  g.add(headGroup);

  // Exposed so a walk cycle (or any other pose) can rotate these directly —
  // see poseWalkCycle(), used by the Village screen's tap-to-walk avatar,
  // and poseTalkCycle(), used by a villager mid-conversation. The character
  // creator ignores both and just leaves everything at rest.
  g.userData.limbs = { leftArm, rightArm, leftLeg, rightLeg };
  g.userData.mouth = mouth;
  // The head group's origin is the neck seam, so rotating it turns/nods the
  // head about the right pivot. Exposed for poseIdleCycle: at the size a
  // villager is actually drawn, a turning head is the only motion that
  // changes their silhouette rather than just nudging it a pixel.
  g.userData.head = headGroup;

  return g;
}

// Swings the arms/legs of a buildCharacter() model into a walk cycle —
// `phase` is a continuously-increasing radians value the caller advances
// while moving (e.g. `phase += dt * 9`), and `amount` (0..1) is how much of
// the swing to apply, so callers can ease in/out around starts and stops
// instead of snapping between walking and standing still.
function poseWalkCycle(characterGroup, phase, amount) {
  const limbs = characterGroup && characterGroup.userData && characterGroup.userData.limbs;
  if (!limbs) return;
  const legSwing = Math.sin(phase) * 0.62 * amount;
  const armSwing = Math.sin(phase) * 0.5 * amount;
  limbs.leftLeg.rotation.x = legSwing;
  limbs.rightLeg.rotation.x = -legSwing;
  limbs.leftArm.rotation.x = -armSwing;
  limbs.rightArm.rotation.x = armSwing;
  // Z is zeroed here for the same reason X is assigned rather than added:
  // this runs first every frame for both the avatar and every villager, so
  // it's what gives the other poses a clean base to work from.
  //
  // Bug fixed 2026-09-28: without this, nothing ever reset arm Z. poseIdleCycle
  // ADDS to it (deliberately — see its comment about easing between states),
  // so a standing villager's nudge accumulated every frame instead of being a
  // per-frame offset. Measured: left arm Z reached -121 radians after 60
  // seconds of standing still, about 19 full revolutions of the shoulder,
  // which dragged the hands through the hips, torso and head — a hand was
  // inside the body in 51% of sampled frames. It scaled with frame rate
  // (-60.8 / -121.5 / -243.1 at 30 / 60 / 120 fps), so it was twice as bad on
  // a 120Hz phone. The avatar was unaffected because only NPCs run the idle
  // pose. Earlier sign fixes to individual gestures were real but worth ~0.3
  // radians against a drift of 121, so they could never have been enough.
  limbs.leftArm.rotation.z = 0;
  limbs.rightArm.rotation.z = 0;
}

// Animates a buildCharacter() model for a villager mid-conversation (see
// startTalking() in the Village screen) — same phase/amount convention as
// poseWalkCycle: `phase` increases continuously while talking, `amount`
// (0..1) eases in/out around the start/end of the conversation. Two sine
// waves at different speeds drive the mouth's open/close so it doesn't read
// as a metronome, and the arms lift slightly on a separate axis (Z, not
// poseWalkCycle's X) so the two poses could coexist without fighting if a
// villager were ever both walking and talking at once.
function poseTalkCycle(characterGroup, phase, amount) {
  const data = characterGroup && characterGroup.userData;
  if (!data) return;
  if (data.mouth) {
    const chatter = Math.max(0, Math.sin(phase * 2.4)) * 0.5 + Math.max(0, Math.sin(phase * 3.7 + 1.3)) * 0.35;
    data.mouth.scale.y = 1 + chatter * amount;
  }
  if (data.limbs) {
    const gesture = Math.sin(phase * 1.6) * 0.14 * amount;
    data.limbs.leftArm.rotation.z = gesture;
    data.limbs.rightArm.rotation.z = -gesture;
  }
}

// Bends a buildCharacter() model's legs forward into a seated pose for a
// villager resting on a bench or a beach lounger (see NPC_SIT_HEIGHT/
// BEACH_SIT_HEIGHT and animate()'s per-npc wander loop, which also lerps
// the whole character up to seat height by this same `amount`) — `amount`
// (0..1) eases in/out exactly like poseWalkCycle's, so sitting down/
// standing up is a smooth motion rather than a snap. `bend` (radians,
// defaults to the bench's -1.35) is how far forward the legs swing — a
// beach lounger reclines lower, so it passes a slightly deeper bend (see
// BEACH_SIT_BEND). These are simple one-segment legs (no separate knee
// joint), so a forward swing reads as "legs resting out in front of a
// seat" rather than a bent knee — the right approximation for this
// low-poly style rather than the wrong shape for a more detailed rig.
function poseSitCycle(characterGroup, amount, bend) {
  const limbs = characterGroup && characterGroup.userData && characterGroup.userData.limbs;
  // Bug fixed 2026-09-01: this used to always assign leg rotation, even at
  // amount 0 — since it's called every single frame right after
  // poseWalkCycle() for both the avatar and every villager (see animate()),
  // that unconditional assignment was silently zeroing the walk cycle's own
  // leg swing back out on every frame nobody was sitting, i.e. almost all
  // the time. Bailing out below a small threshold instead leaves whatever
  // poseWalkCycle already set for that frame alone, and still hands control
  // back to poseSitCycle cleanly once amount actually rises again.
  if (!limbs || amount < 0.001) return;
  const rotation = (bend === undefined ? -1.35 : bend) * amount;
  limbs.leftLeg.rotation.x = rotation;
  limbs.rightLeg.rotation.x = rotation;
}

// Gentle idle motion for a standing-still buildCharacter() model — a
// villager just standing at home or observing a structure previously read
// as frozen, since poseWalkCycle/poseSitCycle only ever move the legs and
// only while actually walking/sitting. `phase` increases continuously while
// idle (see the per-npc loop in animate()), `amount` (0..1) eases in/out
// around a stop, same convention as every other pose here. Deliberately
// moves the whole character group's own transform rather than any
// individual limb, so it can never fight poseWalkCycle's leg swing,
// poseSitCycle's leg bend, or poseTalkCycle's arm gesture — all of those
// only ever touch userData.limbs, never the group's own position/rotation.
// Villagers spend 4-6 minutes at a time standing outside their house (see
// NPC_IDLE_MIN/MAX — that dwell time is deliberate and stays), so this is the
// pose they are in for most of the game. The previous version was a 0.018
// bob and a 2-degree lean, which sounds subtle and reads as nothing at all: a
// villager is about 28px tall on screen, so 0.018 world units is under half a
// pixel of movement. It has to be gestural, not micro.
//
// `phase` is in seconds and starts at a random offset per villager, so nobody
// moves in lockstep. Arm rotations are ADDED rather than assigned, because
// poseWalkCycle/poseSitCycle assign theirs first and idle runs last — during
// the ease between states both are live, and overwriting would snap the arms.
// Cheap deterministic hash: one villager's seed fans out into as many
// independent-looking values as the pose needs, and always the same ones, so
// a villager keeps their own manner frame to frame.
function idleHash(seed, n) {
  const x = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function poseIdleCycle(characterGroup, phase, amount, seed) {
  if (!characterGroup) return;
  const data = characterGroup.userData || {};
  const limbs = data.limbs;
  const s = seed || 0;
  // Every rate and amplitude is jittered per villager. This is what makes
  // synchronisation effectively impossible rather than merely unlikely: two
  // villagers running at different frequencies cannot stay in step even if
  // they start identically — they can only cross for an instant.
  const v = (n, lo, hi) => lo + idleHash(s, n) * (hi - lo);
  // Head-turn rates raised 1.8x on 2026-09-28 (0.37/0.22 -> 0.67/0.40). The
  // old pair swept the head up to ~45 degrees at an average of 7 deg/sec, so
  // one look from side to side took about six seconds — slow enough to read
  // as eerie rather than calm. The amplitude is deliberately unchanged; it
  // was the speed that was wrong, not how far they look.
  const headRateA = 0.67 * v(1, 0.72, 1.28);
  const headRateB = 0.40 * v(2, 0.72, 1.28);
  const shiftRateA = 0.41 * v(3, 0.72, 1.28);
  const shiftRateB = 0.26 * v(4, 0.72, 1.28);
  const breathRate = 1.5 * v(5, 0.8, 1.25);
  const armRate = 0.66 * v(6, 0.72, 1.28);
  // Amplitudes vary too, not just rates. Villagers on different frequencies
  // inevitably drift THROUGH each other's phase now and then; if their poses
  // were the same size they would look alike for the few seconds that takes.
  // Different magnitudes mean even a phase crossing doesn't produce a match.
  const headAmp = v(7, 0.78, 1.25);
  const leanAmp = v(11, 0.7, 1.35);
  const armAmp = v(12, 0.7, 1.35);
  const bobAmp = v(13, 0.75, 1.3);
  // Taken straight from the (stratified) seed rather than through the hash:
  // hashing an evenly-spread seed produces uncorrelated values again and
  // throws away the very spacing that stops two villagers gesturing together.
  //
  // Capped so nobody is ever left standing around for long: the gesture
  // occupies the last 28% of each period, so the quiet gap between gestures
  // is 0.72 * period — at most about 7 seconds, comfortably inside the ten
  // the user asked for. The old 9.5-18.5 range left villagers doing nothing
  // noticeable for up to 15 seconds at a stretch.
  const gesturePeriod = 6.5 + s * 3.3;
  const offA = v(9, 0, 6.283);
  const offB = v(10, 0, 6.283);

  characterGroup.position.y = Math.sin(phase * breathRate + offA) * 0.022 * bobAmp * amount;
  const shift = Math.sin(phase * shiftRateA + offB) * 0.55 + Math.sin(phase * shiftRateB + 2.1) * 0.45;
  characterGroup.rotation.z = shift * 0.07 * leanAmp * amount;

  // Looking around — the cue that actually reads from across the town.
  if (data.head) {
    data.head.rotation.y =
      (Math.sin(phase * headRateA + offA) * 0.55 + Math.sin(phase * headRateB + 1.7) * 0.3) * headAmp * amount;
    data.head.rotation.x = Math.sin(phase * 0.85 + offB) * 0.08 * amount;
  }

  if (limbs) {
    limbs.leftArm.rotation.x += Math.sin(phase * armRate + offB) * 0.12 * armAmp * amount;
    limbs.rightArm.rotation.x += Math.sin(phase * armRate + offB + 0.9) * 0.12 * armAmp * amount;
    // Both arms take the SAME sign here. A positive rotation.z swings either
    // arm toward +x, so mirroring the sign makes them converge and diverge —
    // a flap, not a sway. Matching signs drifts them together with the
    // weight shift, which is what a body actually does.
    limbs.leftArm.rotation.z += shift * 0.07 * leanAmp * amount;
    limbs.rightArm.rotation.z += shift * 0.07 * leanAmp * amount;

    // A gesture on each villager's own period. Firing this often would get
    // repetitive if it were always the same stretch, so there are four and
    // which one plays is picked per cycle from the villager's own seed — two
    // villagers gesturing at the same moment are most likely doing different
    // things, and no villager repeats a predictable loop.
    const cycleNo = Math.floor(phase / gesturePeriod);
    const cycle = (phase % gesturePeriod) / gesturePeriod;
    if (cycle > 0.72) {
      const u = (cycle - 0.72) / 0.28;      // 0..1 progress through the gesture
      const e = Math.sin(u * Math.PI);      // ease in and back out
      const kind = Math.floor(idleHash(s + cycleNo * 0.7717, 21) * 4);
      if (kind === 0) {
        // Stretch — both arms up and back down.
        limbs.leftArm.rotation.x -= e * 1.45 * amount;
        limbs.rightArm.rotation.x -= e * 1.45 * amount;
        // Outward, away from the body. The signs used to be the other way
        // round, which swung both arms IN across the chest — measured: at
        // +0.55 the left hand travels from x -0.49 to -0.20, i.e. through the
        // torso. Negative opens the left arm out, positive the right.
        limbs.leftArm.rotation.z -= e * 0.3 * amount;
        limbs.rightArm.rotation.z += e * 0.3 * amount;
        if (data.head) data.head.rotation.x -= e * 0.18 * amount;
      } else if (kind === 1) {
        // Glance right round behind them, leaning into it.
        const dir = idleHash(s + cycleNo * 0.31, 22) > 0.5 ? 1 : -1;
        if (data.head) data.head.rotation.y += e * 1.15 * amount * dir;
        characterGroup.rotation.z += e * 0.05 * amount * dir;
      } else if (kind === 2) {
        // Shrug — shoulders and arms out, and a small lift.
        limbs.leftArm.rotation.z -= e * 0.55 * amount;
        limbs.rightArm.rotation.z += e * 0.55 * amount;
        limbs.leftArm.rotation.x -= e * 0.25 * amount;
        limbs.rightArm.rotation.x -= e * 0.25 * amount;
        characterGroup.position.y += e * 0.03 * amount;
      } else {
        // Two quick nods.
        if (data.head) data.head.rotation.x += Math.sin(u * Math.PI * 4) * 0.3 * e * amount;
      }
    }
  }

  // A neck stop, applied last so it bounds every contribution above together.
  // The ambient sweep and the glance gesture are each within range on their
  // own, but they ADD — a glance landing on an already-turned head reached a
  // measured 124 degrees on some villagers (0.5% of the time), well past the
  // ~90 a real neck manages, and an owl turn is exactly the kind of thing
  // that reads as unsettling without being obvious. Clamping rather than
  // scaling either motion down keeps both looking right and only catches the
  // rare overshoot — and a head that hits its limit and stops IS what a real
  // neck does.
  if (data.head) {
    const HEAD_YAW_LIMIT = Math.PI / 2;   // 90 degrees
    data.head.rotation.y = Math.max(-HEAD_YAW_LIMIT, Math.min(HEAD_YAW_LIMIT, data.head.rotation.y));
  }
}

// ---- Facial features — drawn as flat 2D images on canvas, then applied
// as textures on planes stuck to the face. Same technique already used for
// the village houses' windows: real geometry for the body, flat painted
// detail for small face-scale features.
function makeCanvasTexture(w, h, drawFn) {
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  drawFn(cnv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cnv);
  tex.anisotropy = 4;
  return tex;
}

function featurePlane(tex, w, h) {
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}

function shadeColor(hex, amt) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(amt > 0 ? '#ffffff' : '#000000'), Math.abs(amt));
  return '#' + c.getHexString();
}

// A hex color as a canvas rgba() string at the given alpha — needed for
// gradients that have to fade all the way out to transparent, which is the
// only way to paint a soft feature onto skin with no visible rim.
function rgbaFrom(hex, alpha) {
  const c = new THREE.Color(hex);
  return 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' +
    Math.round(c.b * 255) + ',' + alpha + ')';
}

// One eye, drawn cute-first. The old version was a white sclera with a
// small dark pupil floating in the middle of it, which at this render size
// read as a beady, staring dot — the single strongest "creepy doll" signal
// on the old face. This is the opposite approach, and the one nearly every
// appealing cartoon character uses: a large, soft, warm-black eye that
// fills its whole shape, with no visible whites at all, lifted by two
// catchlights. Two is the important part — one highlight reads as a painted
// dot, two reads as a wet eye with something behind it.
// The iris color every character shares. There's no eye-color option in the
// creator, and brown sits comfortably against every skin tone in the palette.
const EYE_IRIS = '#6B4A2F';

// One eye, drawn with real anatomy — and deliberately MATTE.
//
// Two passes went wrong here before this one, in different ways, and both
// are worth keeping in mind:
//
// 1. A big solid near-black ellipse with no structure at all. Solid eyes
//    work on flat, graphic faces (Animal Crossing, Peanuts) but this head
//    is shaded 3D with a nose, lips and ears, so a featureless eye
//    read as a hole. The eye's level of detail has to match the face's.
// 2. The anatomy that fixed that was then painted GLOSSY — a radial
//    gradient lit from a bright centre, plus two hard white specular dots.
//    The user's words were "shiny, beady... creepy", which is exactly
//    right: a bright specular on a dark round surface is the signature of a
//    glass doll's eye, and it is about the strongest creepiness cue an eye
//    can carry.
//
// So: there is no highlight anywhere in here, and no gradient that implies
// a polished sphere. Shading is still fine — the upper lid casts a real
// shadow downward, which is light behaving like light. Shine is not: it
// implies a hard wet surface catching a point source, and that is the bit
// that reads as glass rather than as a person.
//
// The iris is still drawn TALLER than the eye opening so the lids clip it
// top and bottom. A fully visible circular iris with white all the way
// around it is the anatomy of a stare.
//
// The canvas is sized to the plane's own aspect ratio by the caller, so a
// circle drawn here stays a circle on the face instead of being stretched.
function drawCuteEye(ctx, w, h, style) {
  const cx = w / 2, cy = h / 2;
  const rx = w * 0.47;
  const ry = h * (style === 'almond' ? 0.42 : 0.46);

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();

  // Sclera — a flat, warm off-white, and flat on purpose. A white that
  // brightens anywhere reads as wet.
  ctx.fillStyle = '#EFE9E2';
  ctx.fillRect(0, 0, w, h);

  // Iris size, as a multiple of the opening's own half-height. One ratio
  // can't serve all three openings, because they aren't the same shape:
  // 'almond' is shallow and wide, so an iris TALLER than the opening (1.08)
  // is exactly what gets it clipped by the lids with sclera still showing at
  // the corners. 'round' and 'wide' are far taller for their width, and at
  // that same 1.08 the iris came out nearly as wide as the whole opening —
  // it swallowed the sclera and spilled past the lids top and bottom. They
  // need an iris that sits INSIDE the opening's height, with the lash line
  // just kissing its top edge, which is what keeps white either side of it.
  const ir = ry * (style === 'almond' ? 1.08 : 0.84);
  const iy = cy + ry * (style === 'almond' ? 0.08 : 0);

  // Iris — essentially one flat colour, darkening only slightly right at
  // the rim so it still reads as round rather than as a pasted disc. No lit
  // centre: that was what made it look blown in glass.
  const iris = ctx.createRadialGradient(cx, iy, ir * 0.3, cx, iy, ir);
  iris.addColorStop(0, EYE_IRIS);
  iris.addColorStop(0.7, EYE_IRIS);
  iris.addColorStop(1, shadeColor(EYE_IRIS, -0.22));
  ctx.beginPath();
  ctx.arc(cx, iy, ir, 0, Math.PI * 2);
  ctx.fillStyle = iris;
  ctx.fill();

  // Faint radial fibres. Texture, not shine — they break the iris up so it
  // isn't a flat plastic disc, without adding anything that glints.
  ctx.strokeStyle = shadeColor(EYE_IRIS, -0.28);
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = Math.max(1, ir * 0.05);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * ir * 0.45, iy + Math.sin(a) * ir * 0.45);
    ctx.lineTo(cx + Math.cos(a) * ir * 0.93, iy + Math.sin(a) * ir * 0.93);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // A soft limbal ring — the rim around the iris. Kept thin and low
  // contrast; a hard dark ring is another thing that reads as moulded.
  ctx.beginPath();
  ctx.arc(cx, iy, ir * 0.95, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(40,29,21,0.35)';
  ctx.lineWidth = ir * 0.1;
  ctx.stroke();

  // Pupil — dark, but a warm near-black rather than a pure one.
  ctx.beginPath();
  ctx.arc(cx, iy, ir * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = '#241A14';
  ctx.fill();

  // The shadow the upper lid casts down onto the eye — the only tonal
  // variation left, and it falls from above like a real shadow instead of
  // sitting where a point light would bounce off a curved surface.
  const lid = ctx.createLinearGradient(0, cy - ry, 0, cy + ry * 0.25);
  lid.addColorStop(0, 'rgba(52,38,28,0.34)');
  lid.addColorStop(1, 'rgba(52,38,28,0)');
  ctx.fillStyle = lid;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();

  // Lid line. Soft all the way round so the eye reads as an opening in the
  // face rather than a decal stuck on it, and heavier along the top where
  // the lashes actually are.
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(74,52,38,0.4)';
  ctx.lineWidth = Math.max(1.5, h * 0.03);
  ctx.stroke();

  // Heavier along the top, where the lashes actually are — but only a
  // little. At h * 0.075 in near-black this stopped reading as a lid and
  // started reading as drawn-on eyeliner, which was the single strongest
  // reason every face came out feminine regardless of the rest of the
  // build. Softer and browner keeps the eye defined without the makeup cue;
  // an actually feminine face gets there through `lashes` instead.
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, Math.PI * 2);
  ctx.strokeStyle = '#463427';
  ctx.lineWidth = Math.max(2, h * 0.055);
  ctx.lineCap = 'round';
  ctx.stroke();
}

// Wider than tall — real eyes are, and an eye taller than it is wide reads
// as startled before anything else about it is taken in. The ratios were
// pushed further in that direction here (round went 1.23 : 1 to 1.46 : 1,
// wide 1.20 to 1.47) because a near-circular opening is a doe eye, and a
// doe eye reads feminine on any face you put it on. These are the default
// for every character in the game, so they have to sit neutral.
const EYE_TEX_SIZE = { round: [0.285, 0.195], almond: [0.3, 0.17], wide: [0.315, 0.215] };

// `lashes` is NPC-only — never set from the character creator's own cfg,
// just from a villager's hand-authored character config (see
// villagerNpcLayout/VILLAGER_ARCHETYPES) — so it never changes what the
// player's own avatar looks like.
function addEyes(g, style, headY, featR, lashes) {
  const [pw, ph] = EYE_TEX_SIZE[style];
  // Canvas dimensions track the plane's own proportions, so circles drawn
  // in here (the iris, the pupil) don't come out as ovals on the face.
  const cw = Math.round(pw * 720), ch = Math.round(ph * 720);

  [-1, 1].forEach((side) => {
    const tex = makeCanvasTexture(cw, ch, (ctx, w, h) => {
      drawCuteEye(ctx, w, h, style);
      // A short fan of lashes off the outer (temple-side) corner — drawn
      // mirrored per side here in canvas space rather than by flipping the
      // plane, so they sweep away from the nose on both eyes instead of
      // both pointing the same absolute direction.
      if (lashes) {
        const dir = side > 0 ? 1 : -1;
        ctx.strokeStyle = '#2A1E16';
        ctx.lineWidth = Math.max(2, h * 0.055);
        ctx.lineCap = 'round';
        for (let i = 0; i < 3; i++) {
          const t = i / 2;
          const x0 = w / 2 + dir * w * (0.2 + t * 0.16);
          const y0 = h * (0.3 - t * 0.06);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.quadraticCurveTo(x0 + dir * w * 0.06, y0 - h * 0.14, x0 + dir * w * 0.13, y0 - h * 0.24);
          ctx.stroke();
        }
      }
    });

    const plane = featurePlane(tex, pw, ph);
    placeOnFace(plane, side, FACE_EYE_X, FACE_EYE_Y, pw, ph, headY, featR, 0.02);
    plane.rotation.z = style === 'almond' ? side * -0.08 : 0;
    g.add(plane);
  });
}

// Eyebrows. The old face had none at all, which is a large part of why it
// read as blank and staring — brows are what make a face look like it's
// feeling something rather than just pointing at you. Drawn in the
// character's own hair color (darkened a little so pale blondes still
// register), arched up toward the middle and settling outward, which is the
// relaxed/friendly shape. Angling them the other way would read as angry.
function addBrows(g, hairColor, headY, featR) {
  const color = shadeColor(hairColor || '#3A2A1E', -0.15);
  [-1, 1].forEach((side) => {
    const tex = makeCanvasTexture(128, 64, (ctx, w, h) => {
      const inner = side > 0 ? w * 0.14 : w * 0.86;
      const outer = side > 0 ? w * 0.9 : w * 0.1;
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      // Only gently arched: thick, steeply-arched brows read as a scowl at
      // this scale, and were the harshest thing left on the face. But a
      // THIN, high, strongly-arched brow is a feminine one, so this sits a
      // little heavier and a lot flatter than the first pass — the arch is
      // most of what's left of the gendered read once the lid line is
      // softened. FACE_BROW_Y also brings them down closer to the eye,
      // which is the other half of it: a high brow reads feminine, a low
      // one neutral.
      ctx.lineWidth = h * 0.28;
      ctx.beginPath();
      ctx.moveTo(inner, h * 0.62);
      ctx.quadraticCurveTo(w * 0.5, h * 0.44, outer, h * 0.5);
      ctx.stroke();
    });
    const plane = featurePlane(tex, 0.19, 0.075);
    placeOnFace(plane, side, FACE_EYE_X, FACE_BROW_Y, 0.19, 0.075, headY, featR, 0.02);
    g.add(plane);
  });
}

const NOSE_TEX_SIZE = { button: [0.125, 0.11], point: [0.105, 0.14], wide: [0.15, 0.125] };

// The nose is now a plain soft bump: a shaded blob and nothing else. It used
// to be drawn with two dark nostril holes, and two dark holes above a mouth
// is a skull — at this size that was reading as genuinely unsettling rather
// than as detail. It's also smaller than before in absolute terms, and the
// head around it got bigger, so it takes up noticeably less of the face.
function addNose(g, style, headY, noseColor, featR) {
  // The nose is drawn as SHADING ON THE SKIN, not as an object sitting on
  // top of it: the gradient starts barely lighter than the skin tone and
  // fades out to fully transparent at the rim, so there's no hard edge
  // anywhere. Earlier passes gave it a bright specular and an opaque
  // outline, and both times it stopped reading as a nose and became a pale
  // bead stuck to the middle of the face.
  const highlight = rgbaFrom(shadeColor(noseColor, 0.1), 0.95);
  const mid = rgbaFrom(noseColor, 0.8);
  const shadow = shadeColor(noseColor, -0.38);
  const [pw, ph] = NOSE_TEX_SIZE[style];

  const tex = makeCanvasTexture(96, 96, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2;
    const grad = ctx.createRadialGradient(cx - w * 0.12, cy - h * 0.2, 2, cx, cy + h * 0.08, w * 0.52);
    grad.addColorStop(0, highlight);
    grad.addColorStop(0.4, mid);
    grad.addColorStop(0.82, rgbaFrom(shadow, 0.6));
    grad.addColorStop(1, rgbaFrom(shadow, 0));
    ctx.fillStyle = grad;
    if (style === 'button') {
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.34, h * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (style === 'point') {
      // A soft rounded wedge — narrow at the bridge, widening to a blunt
      // tip. No hard point: a sharp nose on a round head reads as severe.
      ctx.beginPath();
      ctx.moveTo(cx, h * 0.16);
      ctx.quadraticCurveTo(w * 0.76, h * 0.66, cx, h * 0.86);
      ctx.quadraticCurveTo(w * 0.24, h * 0.66, cx, h * 0.16);
      ctx.closePath();
      ctx.fill();
    } else if (style === 'wide') {
      // A rounded bulb that's narrow at the bridge and flares out toward
      // the base, rather than a flat horizontal oval, which read as a snout.
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.11, cy - h * 0.3);
      ctx.quadraticCurveTo(cx - w * 0.33, cy + h * 0.14, cx - w * 0.24, cy + h * 0.32);
      ctx.quadraticCurveTo(cx, cy + h * 0.42, cx + w * 0.24, cy + h * 0.32);
      ctx.quadraticCurveTo(cx + w * 0.33, cy + h * 0.14, cx + w * 0.11, cy - h * 0.3);
      ctx.closePath();
      ctx.fill();
    }
  });

  const plane = featurePlane(tex, pw, ph);
  plane.position.set(0, headY + FACE_NOSE_Y * featR, FACE_NOSE_Z * featR);
  g.add(plane);
}

// A filled smile with actual lips, rather than the single thin dark stroke
// this used to be — a lipless line across a face is a grimace no matter
// which way it curves, and it was too low-contrast to register as a smile
// at all. `feminine` is NPC-only (see addEyes above) and just makes the
// shape fuller and the color a warmer pink, reading as lipstick.
function addMouth(g, headY, featR, feminine) {
  const tex = makeCanvasTexture(180, 110, (ctx, w, h) => {
    const lx = w * 0.14, rx = w * 0.86, ly = h * 0.34;
    const depth = feminine ? 0.94 : 0.9; // how far the smile dips
    const lip = feminine ? 0.42 : 0.46;  // upper lip line — lower = fuller

    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(w * 0.5, h * depth, rx, ly);
    ctx.quadraticCurveTo(w * 0.5, h * lip, lx, ly);
    ctx.closePath();
    ctx.fillStyle = feminine ? '#C0466A' : '#AC5560';
    ctx.fill();

    // Slightly deeper tone along the upper lip line, so the mouth has a
    // near edge and a far edge instead of being one flat shape.
    ctx.strokeStyle = feminine ? 'rgba(126,38,60,0.5)' : 'rgba(120,58,58,0.5)';
    ctx.lineWidth = h * 0.05;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(w * 0.5, h * lip, rx, ly);
    ctx.stroke();

    // Deliberately no catchlight on the lip. There used to be one here to
    // match the eyes', and it went when the eyes' did: a white specular is
    // a wetness cue wherever it lands, and wet is the thing that was making
    // this face read as a doll. The lip line above gives the mouth its near
    // and far edge without any shine.
  });
  const plane = featurePlane(tex, 0.3, 0.18);
  plane.position.set(0, headY + FACE_MOUTH_Y * featR, FACE_MOUTH_Z * featR);
  g.add(plane);
  return plane;
}

function addGlasses(g, style, headY, featR) {
  if (style === 'none') return;
  const eyeY = headY + FACE_EYE_Y * featR;
  const isShades = style === 'shades';
  const frameColor = isShades ? '#20222A' : '#2B2118';
  const lensColor = isShades ? 'rgba(34,36,43,0.88)' : 'rgba(190,231,251,0.14)';
  // The lenses have to be sized off the eyes, not off habit: the eyes
  // roughly doubled in width, so a frame tuned to the old ones would have
  // sat inside them. GLASSES_W/H below are the plane's world size, and
  // eyeXFrac converts each eye's world X into that plane's own coordinates.
  const GLASSES_W = 0.78, GLASSES_H = 0.38;
  const eyeXFrac = (FACE_EYE_X * featR) / (GLASSES_W / 2);

  const tex = makeCanvasTexture(320, 156, (ctx, w, h) => {
    const cy = h / 2;
    const cxL = w / 2 - eyeXFrac * (w / 2);
    const cxR = w / 2 + eyeXFrac * (w / 2);
    ctx.strokeStyle = frameColor;
    ctx.fillStyle = lensColor;
    ctx.lineWidth = 6;
    [cxL, cxR].forEach((cx) => {
      ctx.beginPath();
      if (style === 'square') {
        const rw = w * 0.175, rh = h * 0.33;
        ctx.moveTo(cx - rw, cy - rh);
        ctx.lineTo(cx + rw, cy - rh);
        ctx.lineTo(cx + rw, cy + rh);
        ctx.lineTo(cx - rw, cy + rh);
        ctx.closePath();
      } else {
        ctx.arc(cx, cy, h * 0.38, 0, Math.PI * 2);
      }
      ctx.fill(); ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(cxL + h * 0.36, cy);
    ctx.lineTo(cxR - h * 0.36, cy);
    ctx.stroke();
  });

  const plane = featurePlane(tex, GLASSES_W, GLASSES_H);
  plane.position.set(0, eyeY, FACE_GLASSES_Z * featR);
  g.add(plane);

  // Temple arms — real 3D geometry, not part of the flat face texture,
  // because they need to actually travel around the side of the head to
  // reach the ear rather than just hint at a direction on a frontal plane.
  const templeMat = mat(frameColor, 0.35);
  [-1, 1].forEach((side) => {
    const outer = new THREE.Vector3(side * (FACE_EYE_X * featR + 0.17), eyeY, 0.54 * featR);
    const earPt = new THREE.Vector3(side * EAR_X * featR, headY + EAR_Y * featR, 0.02 * featR);
    g.add(limbSegment(outer, earPt, 0.012, 0.012, templeMat, 8));
  });
}

// Positioned relative to the face layout constants above rather than to
// its own numbers: when FACE_MOUTH_Y moved, every one of these had to move
// with it or the beard would have sat on the chin with the mouth below it.
function addFacialHair(g, style, color, headY, featR) {
  if (style === 'none') return;

  if (style === 'mustache') {
    const tex = makeCanvasTexture(160, 70, (ctx, w, h) => {
      ctx.fillStyle = color;
      // Two overlapping tilted ellipses — bold and unmistakable, unlike a
      // thin crescent outline which nearly disappears at this render size.
      [-1, 1].forEach((side) => {
        ctx.save();
        ctx.translate(w * 0.5 + side * w * 0.2, h * 0.52);
        ctx.rotate(side * 0.32);
        ctx.beginPath();
        ctx.ellipse(0, 0, w * 0.26, h * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    });
    const plane = featurePlane(tex, 0.32, 0.14);
    plane.position.set(0, headY - 0.265 * featR, 0.53 * featR);
    g.add(plane);
  } else if (style === 'goatee') {
    const tex = makeCanvasTexture(140, 180, (ctx, w, h) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(w * 0.15, h * 0.05);
      ctx.quadraticCurveTo(w * 0.5, h * 0.0, w * 0.85, h * 0.05);
      ctx.lineTo(w * 0.78, h * 0.14);
      ctx.quadraticCurveTo(w * 0.5, h * 0.2, w * 0.22, h * 0.14);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(w * 0.32, h * 0.55);
      ctx.quadraticCurveTo(w * 0.5, h * 0.99, w * 0.68, h * 0.55);
      ctx.quadraticCurveTo(w * 0.5, h * 0.68, w * 0.32, h * 0.55);
      ctx.closePath(); ctx.fill();
    });
    const plane = featurePlane(tex, 0.24, 0.34);
    plane.position.set(0, headY - 0.429 * featR, 0.44 * featR);
    g.add(plane);
  } else if (style === 'beard') {
    const tex = makeCanvasTexture(220, 180, (ctx, w, h) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(w * 0.06, h * 0.28);
      ctx.quadraticCurveTo(w * 0.02, h * 0.62, w * 0.24, h * 0.82);
      ctx.quadraticCurveTo(w * 0.5, h * 0.99, w * 0.76, h * 0.82);
      ctx.quadraticCurveTo(w * 0.98, h * 0.62, w * 0.94, h * 0.28);
      ctx.quadraticCurveTo(w * 0.8, h * 0.5, w * 0.5, h * 0.52);
      ctx.quadraticCurveTo(w * 0.2, h * 0.5, w * 0.06, h * 0.28);
      ctx.closePath(); ctx.fill();
    });
    const plane = featurePlane(tex, 0.58, 0.42);
    plane.position.set(0, headY - 0.38 * featR, 0.45 * featR);
    g.add(plane);
  } else if (style === 'full') {
    // Beard shape plus a mustache sitting in the gap at the top of it.
    const tex = makeCanvasTexture(220, 180, (ctx, w, h) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(w * 0.06, h * 0.28);
      ctx.quadraticCurveTo(w * 0.02, h * 0.62, w * 0.24, h * 0.82);
      ctx.quadraticCurveTo(w * 0.5, h * 0.99, w * 0.76, h * 0.82);
      ctx.quadraticCurveTo(w * 0.98, h * 0.62, w * 0.94, h * 0.28);
      ctx.quadraticCurveTo(w * 0.8, h * 0.5, w * 0.5, h * 0.52);
      ctx.quadraticCurveTo(w * 0.2, h * 0.5, w * 0.06, h * 0.28);
      ctx.closePath(); ctx.fill();

      const mcy = h * 0.22;
      [-1, 1].forEach((side) => {
        ctx.save();
        ctx.translate(w * 0.5 + side * w * 0.145, mcy);
        ctx.rotate(side * 0.32);
        ctx.beginPath();
        ctx.ellipse(0, 0, w * 0.19, w * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    });
    const plane = featurePlane(tex, 0.58, 0.42);
    plane.position.set(0, headY - 0.38 * featR, 0.45 * featR);
    g.add(plane);
  }
}

// The hair cap's radius has to stay LARGER than the head sphere's own 0.62,
// or the dome sits inside the skull and only pokes through where the head
// happens to be narrower — which renders as a ragged, sparkling seam around
// the hairline instead of as hair. That's exactly what happened when the
// head was made rounder (its Y/Z scale went up), so this sits clear of 0.62
// rather than just under it.
const HAIR_CAP_R = 0.645;

function addHair(g, style, color, headY, featR) {
  const hairMat = mat(color, 0.7);
  if (style === 'bald') return;
  // Hair is part of the skull, not a protected facial feature — it scales
  // fully (size and position) with HEAD_SHRINK so it keeps hugging the head.
  const s = (v) => v * featR;

  if (style === 'crop') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(s(HAIR_CAP_R), 32, 26, 0, Math.PI * 2, 0, Math.PI / 2.7), hairMat);
    cap.position.y = headY + s(0.03);
    cap.castShadow = true;
    g.add(cap);
  } else if (style === 'spiky') {
    // Same cap as crop/pony/long (position and dome size), so the spikes
    // below have a consistent, correctly-sized surface to actually root
    // into instead of floating above a smaller, lower-sitting cap.
    const capRadius = s(HAIR_CAP_R);
    const crown = new THREE.Vector3(0, headY + s(0.03), 0);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(capRadius, 32, 26, 0, Math.PI * 2, 0, Math.PI / 2.7), hairMat);
    cap.position.copy(crown);
    cap.castShadow = true;
    g.add(cap);
    // Hand-picked angle/elevation/size per spike (not an even ring) for a
    // scattered, uneven look instead of a tidy uniform crown.
    const spikeDefs = [
      { a: 0.15, elev: 1.28, h: 0.46, r: 0.1 },
      { a: 0.7, elev: 0.92, h: 0.32, r: 0.115 },
      { a: 1.55, elev: 1.32, h: 0.4, r: 0.085 },
      { a: 2.2, elev: 0.98, h: 0.3, r: 0.1 },
      { a: 2.75, elev: 1.35, h: 0.44, r: 0.09 },
      { a: 3.65, elev: 0.88, h: 0.36, r: 0.105 },
      { a: 4.3, elev: 1.2, h: 0.38, r: 0.08 },
      { a: 5.05, elev: 1.0, h: 0.28, r: 0.1 },
      { a: 5.75, elev: 1.3, h: 0.42, r: 0.09 },
    ];
    spikeDefs.forEach(({ a, elev, h, r }) => {
      const dir = new THREE.Vector3(
        Math.cos(a) * Math.cos(elev),
        Math.sin(elev),
        Math.sin(a) * Math.cos(elev)
      ).normalize();
      const spikeHeight = s(h);
      // Base sits just inside the cap's own radius (embedded, no gap); tip
      // extends outward from there.
      const baseDist = capRadius - s(0.08);
      const spike = new THREE.Mesh(new THREE.ConeGeometry(s(r), spikeHeight, 12), hairMat);
      spike.position.copy(crown).addScaledVector(dir, baseDist + spikeHeight / 2);
      spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      spike.castShadow = true;
      g.add(spike);
    });
  } else if (style === 'curly') {
    // x, y, z, radius. The last three are a front fringe: without them every
    // puff sat too high and too far back to break the head's own surface
    // anywhere near the hairline, so the character read as balding rather
    // than curly-haired. A puff only shows where its own radius reaches
    // past the head sphere at that height, so the fringe has to sit well
    // forward (high z) as well as low.
    const puffs = [
      [0, 0.46, 0, 0.36], [0.3, 0.4, 0.1, 0.26], [-0.3, 0.4, 0.1, 0.26],
      [0.2, 0.36, -0.3, 0.24], [-0.2, 0.36, -0.3, 0.24], [0, 0.4, 0.34, 0.26],
      [0.36, 0.28, -0.08, 0.22], [-0.36, 0.28, -0.08, 0.22],
      [0.22, 0.26, 0.34, 0.22], [-0.22, 0.26, 0.34, 0.22], [0, 0.26, 0.44, 0.22],
    ];
    puffs.forEach(([x, y, z, r]) => {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(s(r), 18, 14), hairMat);
      puff.position.set(s(x), headY + s(y), s(z));
      puff.castShadow = true;
      g.add(puff);
    });
  } else if (style === 'pony') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(s(HAIR_CAP_R), 32, 26, 0, Math.PI * 2, 0, Math.PI / 2.7), hairMat);
    cap.position.y = headY + s(0.03);
    cap.castShadow = true;
    g.add(cap);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(s(0.14), s(0.55), 16), hairMat);
    tail.position.set(0, headY - s(0.05), s(-0.58));
    tail.rotation.x = Math.PI / 2.3;
    tail.castShadow = true;
    g.add(tail);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(s(0.06), 12, 10), hairMat);
    tip.position.set(0, headY - s(0.42), s(-0.85));
    g.add(tip);
  } else if (style === 'long') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(s(HAIR_CAP_R), 32, 26, 0, Math.PI * 2, 0, Math.PI / 2.7), hairMat);
    cap.position.y = headY + s(0.03);
    cap.castShadow = true;
    g.add(cap);
    // The curtain down the back, and the two things that have to be true of
    // it — both of which the previous cone got wrong, which is why the hair
    // cut straight through the head:
    //
    // 1. It has to open toward the FRONT. thetaStart/phiStart is measured
    //    from +Z, and +Z is the direction the face looks, so a shell that
    //    starts at -0.62π and sweeps 1.24π wraps the FACE and leaves the
    //    back of the skull bare. The curtain then only surfaced where the
    //    head happened to be narrower than it — through the cheeks and jaw.
    // 2. Its profile has to bulge, so this is a partial LATHE rather than a
    //    cone. The skull is at its widest at the equator (x 0.62), so any
    //    straight taper from a crown-sized top either passes through the
    //    head at ear height or has to start wide enough to float off the
    //    crown. The profile follows the skull out to its widest point and
    //    only falls away below it.
    //
    // Profile is [radius, y from the head's center], top to tip. Above the
    // cap's lower edge (y 0.285, radius 0.592) every radius stays under the
    // cap so the top of the curtain is hidden inside it; below that edge
    // every radius clears the skull, so no band of scalp shows between the
    // two.
    const backProfile = [
      [0.52, 0.36], [0.57, 0.29], [0.64, 0.15], [0.68, 0.0], [0.68, -0.15],
      [0.65, -0.32], [0.58, -0.5], [0.48, -0.68], [0.34, -0.82],
      [0.18, -0.9], [0.04, -0.93],
    ].map(([r, y]) => new THREE.Vector2(s(r), s(y)));
    // DoubleSide because the curtain is an open shell: its front edges are
    // seen from the inside as the head turns, and a single-sided surface
    // would just vanish there.
    // Sweeping to 0.30π either side of the face (rather than stopping at
    // 0.38π) is what makes this read as long hair from the FRONT as well as
    // from behind: the curtain comes down past the ears and alongside the
    // cheeks, so the face is framed by the mass itself. The previous pass
    // stopped it short and hung two separate strand cylinders out front
    // instead, which left a bare wedge of temple between mass and strand and
    // read as two slabs stuck to the sides of the head.
    const back = new THREE.Mesh(
      new THREE.LatheGeometry(backProfile, 40, Math.PI * 0.30, Math.PI * 1.40),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7, side: THREE.DoubleSide })
    );
    back.position.y = headY;
    back.castShadow = true;
    g.add(back);
  }
}

// NPC-only hair accessory (see addEyes above for why) — a small bow clipped
// to the upper side of the head, placed the same way regardless of
// hairstyle so it doesn't need per-style tuning: two flattened, splayed
// "wing" spheres plus a small round knot between them read as a bow at this
// scale without needing real ribbon geometry.
function addHairBow(g, color, headY, featR) {
  const s = (v) => v * featR;
  const bowMat = mat(color, 0.5);
  const bow = new THREE.Group();
  [-1, 1].forEach((side) => {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(s(0.17), 16, 12), bowMat);
    wing.position.set(side * s(0.16), 0, 0);
    wing.scale.set(1, 0.68, 0.42);
    wing.rotation.z = side * 0.55;
    wing.castShadow = true;
    bow.add(wing);
  });
  const knot = new THREE.Mesh(new THREE.SphereGeometry(s(0.085), 12, 10), bowMat);
  knot.castShadow = true;
  bow.add(knot);
  // Upper-forward side of the head, clear of even curly's wide side puffs
  // (the bulkiest hairstyle geometry gets), so it reads as clipped on top of
  // the hair instead of buried inside it, regardless of hairstyle.
  bow.position.set(s(0.58), headY + s(0.5), s(0.3));
  bow.rotation.set(0.1, -0.35, 0.1);
  g.add(bow);
}

// ---- Character creator — scene lifecycle ----
let charScene = null, charCamera = null, charRenderer = null, charControls = null;
let charGroup = null;
let charAnimId = null;

function teardownCharacterScene() {
  if (charAnimId !== null) cancelAnimationFrame(charAnimId);
  charAnimId = null;
  if (charControls) { charControls.dispose(); charControls = null; }
  if (charRenderer) {
    charRenderer.dispose();
    if (charRenderer.forceContextLoss) charRenderer.forceContextLoss();
    charRenderer = null;
  }
  charScene = null;
  charCamera = null;
  charGroup = null;
}

function rebuildCharacterModel() {
  if (!charScene) return;
  charScene.remove(charGroup);
  charGroup = buildCharacter(state.character);
  charScene.add(charGroup);
}

function initCharacterScene() {
  teardownCharacterScene();
  const holder = document.getElementById('characterCanvas');
  if (!holder || typeof THREE === 'undefined') return;

  charScene = new THREE.Scene();
  charCamera = new THREE.PerspectiveCamera(30, holder.clientWidth / holder.clientHeight, 0.1, 100);
  charCamera.position.set(0, 1.0, 6.6);

  charRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  charRenderer.setSize(holder.clientWidth, holder.clientHeight);
  charRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  charRenderer.shadowMap.enabled = true;
  charRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  holder.appendChild(charRenderer.domElement);

  charControls = new THREE.OrbitControls(charCamera, charRenderer.domElement);
  charControls.target.set(0, 0.45, 0);
  charControls.enableDamping = true;
  charControls.dampingFactor = 0.08;
  charControls.enablePan = false;
  charControls.enableZoom = false;
  charControls.minPolarAngle = Math.PI / 2.4;
  charControls.maxPolarAngle = Math.PI / 2.05;
  charControls.minAzimuthAngle = -1.05;
  charControls.maxAzimuthAngle = 1.05;

  const hemi = new THREE.HemisphereLight(0xffffff, 0xE8B978, 0.75);
  charScene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d0, 1.0);
  sun.position.set(3, 5.5, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -2;
  sun.shadow.camera.right = 2;
  sun.shadow.camera.top = 3;
  sun.shadow.camera.bottom = -2;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 12;
  sun.shadow.bias = -0.002;
  charScene.add(sun);
  const fill = new THREE.DirectionalLight(0xBFD9FF, 0.35);
  fill.position.set(-3, 2, -2);
  charScene.add(fill);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1.15, 48),
    new THREE.MeshStandardMaterial({ color: 0xFBDA9C, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.18;
  ground.receiveShadow = true;
  charScene.add(ground);

  charGroup = new THREE.Group();
  charScene.add(charGroup);
  rebuildCharacterModel();

  let idleT = 0;
  function animate() {
    charAnimId = requestAnimationFrame(animate);
    idleT += 0.01;
    if (!charControls.isDragging) {
      charGroup.rotation.y = Math.sin(idleT * 0.6) * 0.22;
    }
    charControls.update();
    charRenderer.render(charScene, charCamera);
  }
  animate();
}

const TRIGGER_OPTIONS = ['Stress','Boredom','Anxiety','Loneliness','Exhaustion','Late at night','Other'];

function screenTriggers() {
  return `
    <div class="screen">
      ${backButton()}
      ${editDots('<div class="progress-dots"><span class="on"></span><span class="on"></span><span class="on"></span><span></span><span></span></div>')}
      <div class="txt" style="font-size:15px; margin-top:8px;">When do you usually feel the pull toward the habit you're working on?</div>
      <div class="txt soft tiny">Pick as many as feel true — this decides which quests come up first.</div>
      <div class="chip-row">
        ${TRIGGER_OPTIONS.map(t => `
          <div class="chip ${state.triggers.includes(t) ? 'on' : ''}" onclick="toggleTrigger('${t}')">${t}</div>
        `).join('')}
      </div>
      <div class="spacer"></div>
      <button class="btn" onclick="${isEditingProfile() ? 'goBack()' : "goTo('villageName')"}">${isEditingProfile() ? 'Done' : 'Continue'}</button>
      <button class="btn link" style="align-self:center;" onclick="skipTriggers()">Prefer not to say</button>
    </div>
  `;
}

function toggleTrigger(t) {
  const i = state.triggers.indexOf(t);
  if (i === -1) state.triggers.push(t);
  else state.triggers.splice(i, 1);
  saveState();
  render();
}

function skipTriggers() {
  state.triggers = [];
  saveState();
  if (isEditingProfile()) goBack();
  else goTo('villageName');
}

function screenVillageName() {
  return `
    <div class="screen">
      ${backButton()}
      ${editDots('<div class="progress-dots"><span class="on"></span><span class="on"></span><span class="on"></span><span class="on"></span><span></span></div>')}
      <div class="txt" style="font-size:15px; margin-top:10px;">${isEditingProfile() ? 'What should we call your town?' : 'Got it! Last step — what should we call your town?'}</div>
      <input type="text" id="villageInput" placeholder="Town name" value="${escapeHtml(state.villageName)}" />
      <div class="spacer"></div>
      <button class="btn" onclick="submitVillageName()">${isEditingProfile() ? 'Save' : "Let's build it!"}</button>
    </div>
  `;
}

function submitVillageName() {
  const val = document.getElementById('villageInput').value.trim();
  if (!val) return;
  state.villageName = val;
  saveState();
  if (isEditingProfile()) goBack();
  else goTo('howItWorks');
}

const HOW_IT_WORKS_CARDS = [
  {
    tab: 'village',
    text: () => `This is the Town tab, where you can go to walk around in ${escapeHtml(state.villageName)} and interact with the world.`,
  },
  {
    tab: 'quests',
    text: () => `This is the Quests tab, where you can go to find real-world quests and complete them to earn coins.`,
  },
  {
    tab: 'structureShop',
    text: () => `This is the Structures tab, where you can go to spend your coins on new buildings for ${escapeHtml(state.villageName)}.`,
  },
  {
    tab: null,
    text: () => `That's everything! Welcome to ConnectLife!`,
  },
];

function screenHowItWorks() {
  const i = state.howItWorksIndex;
  const card = HOW_IT_WORKS_CARDS[i];
  const isLast = i === HOW_IT_WORKS_CARDS.length - 1;
  return `
    <div class="screen tutorial-screen" style="text-align:center; position:relative;">
      ${card.tab ? '<div class="tutorial-dim"></div>' : ''}
      ${backButton()}
      <div class="txt soft tiny">${i + 1} / ${HOW_IT_WORKS_CARDS.length}</div>
      <div class="spacer"></div>
      <div class="txt ${card.tab ? 'tutorial-text' : ''}" style="font-size:16px; line-height:1.5;">${card.text()}</div>
      <div class="spacer"></div>
      <div class="dots">${HOW_IT_WORKS_CARDS.map((_, idx) => `<span class="${idx === i ? 'on' : ''}"></span>`).join('')}</div>
      ${isLast ? `<button class="btn" onclick="goTo('emptyVillage')">Let's get started</button>` : ''}
      ${renderNavbar(card.tab, true)}
    </div>
  `;
}

function handleTutorialNavClick(id) {
  const card = HOW_IT_WORKS_CARDS[state.howItWorksIndex];
  if (card.tab && id === card.tab) {
    state.howItWorksIndex += 1;
    saveState();
    render();
  }
}

function screenEmptyVillage() {
  return `
    <div class="screen">
      ${backButton()}
      <div class="txt" style="font-size:15px; margin-top:6px;">${escapeHtml(state.villageName)} is looking a little empty — for now!</div>
      <div class="txt soft tiny">Complete your first quest and watch it start to grow.</div>
      <div class="village-plot" style="position:relative; padding:0;">
        <div id="emptyVillagePreview" style="position:absolute; inset:0;"></div>
      </div>
      <button class="btn sage" onclick="finishOnboarding()">Let's see my first quest</button>
      ${renderNavbar()}
    </div>
  `;
}

// ---------- Quests & structures data ----------

// Every quest carries three duration tiers instead of one fixed length. When
// a quest is picked for the board, one tier is rolled and remembered in
// state.questTiers so the card doesn't re-roll on every render.
//
// Payout depends ONLY on which tier was rolled, never on the quest or its
// actual minutes (see TIER_COINS) — so a 5-minute short pays the same as a
// 45-minute short. Tiers are relative to each quest, not to the clock.
const QUESTS = [
  { id: 'q1', tag: 'Boredom', title: 'Take a walk with a friend', desc: "Grab a friend and go for a walk. No phones, no destination \u2014 just talking.", tiers: [15, 30, 60] },
  { id: 'q2', tag: 'Boredom', title: 'Call a family member', desc: "Give someone in your family a call, just to catch up. No agenda needed.", tiers: [10, 20, 40] },
  { id: 'q3', tag: 'Stress', title: 'Study with a classmate', desc: "Find a classmate and work through it together instead of alone \u2014 even a shared video call helps.", tiers: [30, 60, 90] },
  { id: 'q4', tag: 'Boredom', title: 'Check in on a friend', desc: "Text or call someone you haven't talked to in a while. Doesn't need to be deep \u2014 just say hi.", tiers: [5, 10, 20] },
  { id: 'q5', tag: 'Anxiety', title: 'Sit with someone you trust', desc: "Ask a friend or family member if you can just hang out in the same room for a bit. You don't have to talk about anything.", tiers: [15, 30, 60] },
  { id: 'q6', tag: 'Loneliness', title: 'Invite someone to eat with you', desc: "Ask a friend, roommate, or coworker to share a meal with you instead of eating alone.", tiers: [30, 45, 75] },
  { id: 'q7', tag: 'Exhaustion', title: 'Ask for help with something small', desc: "Reach out to someone and ask for a hand with one task on your plate. Letting people in counts.", tiers: [10, 20, 30] },
  { id: 'q8', tag: 'Late at night', title: 'Text a friend before bed', desc: "Send someone a message before you wind down for the night \u2014 a check-in, a good night, anything real.", tiers: [5, 10, 15] },
  { id: 'q9', tag: 'Other', title: 'Say hi to a neighbor', desc: "Strike up a conversation with a neighbor or someone nearby. Small talk still counts as connection.", tiers: [5, 10, 20] },
  { id: 'q10', tag: 'Loneliness', title: 'Exercise with a friend', desc: "Move your body with someone else \u2014 a run, a lift, a bike ride, a stretch session. Showing up for each other is half of it.", tiers: [20, 45, 75] },
  { id: 'q11', tag: 'Boredom', title: "Call someone you haven't spoken to recently", desc: "Pick someone who's drifted a little and just call them. The first thirty seconds are the hard part \u2014 after that it's easy.", tiers: [10, 25, 45] },
  { id: 'q12', tag: 'Boredom', title: 'Play a video game with someone', desc: "Get someone into a game with you \u2014 couch co-op, online, doesn't matter. Playing together beats playing alone.", tiers: [30, 60, 120] },
  { id: 'q13', tag: 'Boredom', title: 'Play a board or card game with someone', desc: "Dig out a deck of cards or a board game and talk someone into playing. Old-fashioned on purpose.", tiers: [20, 45, 90] },
  { id: 'q14', tag: 'Boredom', title: 'Watch a movie with someone', desc: "Pick something together and actually watch it together \u2014 same couch or same call, just not alone.", tiers: [45, 90, 120] },
  { id: 'q15', tag: 'Stress', title: 'Go to a cafe with a friend', desc: "Get out of your space and into a cafe with someone. A change of scenery plus company does more than either one alone.", tiers: [30, 60, 90] },
  { id: 'q16', tag: 'Stress', title: 'Do something silly together', desc: "Be ridiculous with someone on purpose \u2014 a dumb bit, a bad impression, whatever makes you both laugh.", tiers: [10, 20, 45] },
  { id: 'q17', tag: 'Stress', title: 'Cook something together', desc: "Make something to eat with another person. Split the steps, share the result.", tiers: [30, 60, 90] },
  { id: 'q18', tag: 'Stress', title: 'Make some art with a friend', desc: "Draw, paint, build, write, or play something together. It really doesn't have to be good.", tiers: [20, 45, 90] },
  { id: 'q19', tag: 'Loneliness', title: 'Hang out with someone you want to know better', desc: "Reach out to someone you like but don't really know yet, and make actual plans. This is how acquaintances turn into friends.", tiers: [30, 60, 120] },
  { id: 'q20', tag: 'Exhaustion', title: 'See who knows the other better', desc: "Quiz each other \u2014 favorite food, worst habit, first impression. Find out who's actually been paying attention.", tiers: [10, 20, 40] },
  { id: 'q21', tag: 'Exhaustion', title: 'Send a friend something funny', desc: "Send over a video or post that made you laugh, and stick around for their reaction. Low effort, still counts.", tiers: [5, 10, 20] },
];

// Flat reward per tier: shortest option 20, medium 25, longest 30. Indexed by
// the rolled tier, so every quest's three lengths pay 20/25/30 regardless of
// how many minutes those lengths actually are.
const TIER_COINS = [20, 25, 30];

function coinsForTier(tierIndex) {
  return TIER_COINS[tierIndex] ?? TIER_COINS[0];
}

// Quests recycle instead of being used up. Finishing one puts it on a two-day
// cooldown; after that it's fair game again, usually at a different rolled
// length. "Call a family member" is something you should do again next week,
// not once ever — and with 21 quests and a flat 20/25/30 payout, a one-and-done
// pool would cap a player's lifetime coins below what the shop costs.
//
// The cooldown is a preference, not a hard gate: pickQuests walks the groups
// below in order and only reaches cooling-down quests if there aren't enough
// rested ones to fill the board. That way the board is never short of cards,
// however fast someone plays.
const QUEST_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

function questLastCompletedAt(id) {
  return (state.questCompletedAt && state.questCompletedAt[id]) || 0;
}

function questIsRested(id) {
  const last = questLastCompletedAt(id);
  return !last || Date.now() - last >= QUEST_COOLDOWN_MS;
}

// "45 min" / "1 hr" / "1 hr 30 min"
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hrs} hr ${mins} min` : `${hrs} hr`;
}

const STRUCTURES = [
  { id: 'bench', name: 'Bench', cost: 45 },
  { id: 'garden', name: 'Garden Patch', cost: 30 },
  { id: 'party-hall', name: 'Party Hall', cost: 120 },
  { id: 'fountain', name: 'Fountain', cost: 70 },
  { id: 'beach', name: 'Beach', cost: 90 },
  { id: 'sports-court', name: 'Sports Court', cost: 85 },
];

// Garden Patch has no collision and a tiny footprint, so unlike every other
// structure it can be bought over and over instead of a single time.
const REPEATABLE_STRUCTURE_IDS = new Set(['garden']);

// ---------- Villager progression ----------
// A handful of structures are exciting enough to draw a whole new neighbor
// (and their house) into town the moment they're built — Bench and Garden
// Patch are left out on purpose, too minor to justify someone moving their
// whole life for. Each archetype's `character` reuses the same
// buildCharacter() cfg shape as the player/starting NPCs; `houseColors`
// feeds makeHouse() to give each newcomer's home a look that matches them.
// Once NPC dialogue exists, `role` is what a villager uses to explain why
// they moved in (e.g. the jock showing up for the sports court).
const VILLAGER_ARCHETYPES = {
  'sports-court': {
    role: 'jock', name: 'Jacob', gender: 'male',
    houseColors: { wall: 0xF2D9B0, roof: 0xE0433D, door: '#7A1E1E' },
    character: { skin: '#FDE0C2', eyes: 'round', nose: 'wide', hairStyle: 'spiky', hairColor: '#1B1B1B', outfit: '#E0433D', glasses: 'none', facialHair: 'none' },
  },
  beach: {
    role: 'surfer', name: 'Ruth', gender: 'female',
    houseColors: { wall: 0xEFE3C8, roof: 0x2FB6C4, door: '#1E5E66' },
    character: { skin: '#FFE8D2', eyes: 'wide', nose: 'button', hairStyle: 'long', hairColor: '#E8C56B', outfit: '#2FB6C4', glasses: 'shades', facialHair: 'none', feminine: true, bowColor: '#FF6F91' },
  },
  'party-hall': {
    role: 'social-butterfly', name: 'Abigail', gender: 'female',
    houseColors: { wall: 0xFCE1EF, roof: 0xD6479A, door: '#7A2E5C' },
    character: { skin: '#FCE0C8', eyes: 'almond', nose: 'button', hairStyle: 'pony', hairColor: '#7A2E5C', outfit: '#D6479A', glasses: 'none', facialHair: 'none', feminine: true, bowColor: '#FFD166' },
  },
  // A sucker for old, sculpted fountains specifically — the fountain is
  // what brought them, so an artist/historical-sculpture type read best.
  fountain: {
    role: 'sculpture-artist', name: 'Elijah', gender: 'male',
    houseColors: { wall: 0xE8E0F5, roof: 0x6B4E9E, door: '#3F2E5E' },
    character: { skin: '#F5D9BB', eyes: 'almond', nose: 'point', hairStyle: 'curly', hairColor: '#4A4A4A', outfit: '#6B4E9E', glasses: 'round', facialHair: 'goatee' },
  },
};

// How many structure-triggered villagers the town can hold — matches the 4
// archetypes in VILLAGER_ARCHETYPES exactly. The user explicitly decided
// against ever adding a 5th, so this isn't padded with extra headroom
// anymore — if a 5th archetype is ever added after all, raise this to match.
const MAX_VILLAGERS = 4;

// Called right after a structure is confirmed into state.village. Adds a
// themed neighbor (house placement is resolved later, in
// layoutVillageBoard) unless this structure has no matching archetype,
// already has its villager (can't happen today since only Garden Patch is
// repeatable and it has no archetype, but kept as a guard), or the town's
// already full up.
function maybeSpawnVillager(structureId) {
  const archetype = VILLAGER_ARCHETYPES[structureId];
  if (!archetype) return;
  if (state.villagers.length >= MAX_VILLAGERS) return;
  if (state.villagers.some(v => v.structureId === structureId)) return;
  state.villagers.push({
    id: `villager-${structureId}-${Date.now()}`,
    structureId,
    role: archetype.role,
    name: archetype.name,
    gender: archetype.gender,
    character: { ...archetype.character },
    houseColors: { ...archetype.houseColors },
    metPlayer: false,
  });
}

// ---------- Villager dialogue ----------
// Every villager's "why I'm here" line — keyed by the structure that drew
// them in. A villager with no `structureId` (the 2 fixed starting
// neighbors) has no structure to credit, so they get a generic "just moved
// in" line instead (see villagerReasonText below).
const STRUCTURE_REASON_TEXT = {
  'sports-court': () => `I heard ${state.villageName} just got a sports court, and I couldn't stay away from a court like that!`,
  beach: () => `I heard ${state.villageName} got a beach, and there's no way I could stay away from waves like that!`,
  'party-hall': () => `I heard ${state.villageName} opened a party hall, and there was no way I was missing out on that!`,
  fountain: () => `I saw that gorgeous fountain in ${state.villageName}, and I just had to move in — I'm such a sucker for a beautifully sculpted fountain.`,
};

function villagerReasonText(npc) {
  const reason = npc.structureId && STRUCTURE_REASON_TEXT[npc.structureId];
  if (reason) return reason();
  return `I've just moved in, and I'm excited to watch this beautiful town grow with you, Mayor ${state.name}.`;
}

// The whole point of this file's easter egg: if the player's own name
// matches a villager's name (case-insensitively), the very first
// conversation opens with them geeking out about being "name buddies"
// before getting to their normal reason for moving in — which then starts
// with "Anyway, " instead of "Oh, hi!" since it's no longer their opening
// line.
function firstMeetingLines(npc) {
  const reason = villagerReasonText(npc);
  const nameBuddy = !!(npc.name && state.name && npc.name.trim().toLowerCase() === state.name.trim().toLowerCase());
  if (nameBuddy) {
    return [
      `Oh, hi Mayor ${state.name}, I'm new here to ${state.villageName}. I'm so excited. And guess what my name is: ${npc.name}! Yep, we're name buddies. I'm so excited.`,
      `Anyway, ${reason}`,
    ];
  }
  return [`Oh, hi! ${reason}`];
}

// What a villager says on every conversation after the first — generic
// small-talk about the town/scenery, picked from whichever pool matches
// what they're actually doing right now (see the ambient wandering system
// in the Village screen: npc.behavior.mode/dest). Each pool has 3 lines,
// chosen at random per visit so it doesn't repeat itself every time.
const REPEAT_VISIT_LINES = {
  // Sitting on a bench.
  benchSit: [
    () => `Just resting my feet for a minute — a bench like this is such a nice touch on this town, Mayor ${state.name}.`,
    () => `You can see a lot from right here. I like just watching everyone go about their day.`,
    () => `Mind if I sit a while longer? It's nice just being still sometimes.`,
  ],
  // Sitting in one of the Beach's lounger chairs.
  beachSit: [
    () => `Just soaking up the sun for a bit — is there anything better than the sound of waves?`,
    () => `I could stare out at the horizon all day out here.`,
    () => `Working on my tan, don't mind me. ${state.villageName}'s got a great coastline.`,
  ],
  // Standing and admiring some other placed structure — `structureName` is
  // filled in from STRUCTURES (e.g. "fountain", "party hall").
  observe: [
    (structureName) => `I was just taking a moment to appreciate the ${structureName}. ${state.villageName} really is looking great.`,
    (structureName) => `Every time I pass the ${structureName}, I notice something new about it.`,
    (structureName) => `It's little things like the ${structureName} that make this town feel like home.`,
  ],
  // Idle at home, mid-walk, or pausing at a random open spot with nothing
  // in particular nearby — the catch-all fallback.
  general: [
    () => `Beautiful day to be out in ${state.villageName}, isn't it, Mayor ${state.name}?`,
    () => `I was just out enjoying the fresh air — this town has a nice feel to it.`,
    () => `Funny running into you out here! I do love a good walk around town.`,
  ],
};

function repeatVisitLine(npc) {
  const dest = npc.behavior && npc.behavior.mode === 'interacting' ? npc.behavior.dest : null;
  let pool = REPEAT_VISIT_LINES.general;
  let structureName = null;
  if (dest && dest.kind === 'sit') {
    pool = dest.type === 'beach' ? REPEAT_VISIT_LINES.beachSit : REPEAT_VISIT_LINES.benchSit;
  } else if (dest && dest.kind === 'observe') {
    pool = REPEAT_VISIT_LINES.observe;
    const model = STRUCTURES.find((s) => s.id === dest.type);
    structureName = (model ? model.name : 'town').toLowerCase();
  }
  const line = pool[Math.floor(Math.random() * pool.length)];
  return line(structureName);
}

function hasMetVillager(npc) {
  if (npc.structureId) {
    const v = state.villagers.find(x => x.id === npc.id);
    return !!(v && v.metPlayer);
  }
  return !!state.metNeighbors[npc.id];
}

function markVillagerMet(npc) {
  if (npc.structureId) {
    const v = state.villagers.find(x => x.id === npc.id);
    if (v) v.metPlayer = true;
  } else {
    state.metNeighbors[npc.id] = true;
  }
  saveState();
}

// ---------- Village 3D scene — walk-around world ----------
// The village is a real Three.js scene: a fixed town core (town hall + three
// homes) plus whatever the player has bought from the Structures shop,
// scattered outward in a golden-angle spiral so new purchases never need
// manual arranging. The player's own low-poly character (same builder as
// the character creator) walks on tap, with simple circle-vs-circle
// collision against every building so it can't walk through them.

function makeWindowTexture(frameColor, paneColor) {
  return makeCanvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = frameColor;
    ctx.fillRect(0, 0, w, h);
    const pad = 16;
    ctx.fillStyle = paneColor;
    ctx.fillRect(pad, pad, w - pad * 2, h - pad * 2);
    ctx.strokeStyle = frameColor;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(w / 2, pad); ctx.lineTo(w / 2, h - pad);
    ctx.moveTo(pad, h / 2); ctx.lineTo(w - pad, h / 2);
    ctx.stroke();
  });
}

// A simple house: box walls, pyramid roof sized to the wall footprint exactly
// (no overhang — the roof cone is rotated/scaled to match, same trick as the
// approved style-c-real3d.html mockup), a door, and a painted window.
function makeHouse(wallColor, roofColor, doorColor) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 1, 1.2),
    new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.85 })
  );
  body.position.y = 0.5;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const roofGeo = new THREE.ConeGeometry(1.05, 0.75, 4);
  roofGeo.rotateY(Math.PI / 4);
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.6 }));
  const roofBaseSide = 1.05 * Math.SQRT2;
  roof.scale.set(1.4 / roofBaseSide, 1, 1.2 / roofBaseSide);
  roof.position.y = 1.37;
  roof.castShadow = true;
  g.add(roof);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.42, 0.05),
    new THREE.MeshStandardMaterial({ color: doorColor, roughness: 0.7 })
  );
  door.position.set(0.32, 0.21, 0.61);
  g.add(door);

  const win = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, 0.36),
    new THREE.MeshBasicMaterial({ map: makeWindowTexture('#ffffff', '#BEE7FB') })
  );
  win.position.set(-0.32, 0.6, 0.611);
  g.add(win);

  return g;
}

// The town hall — bigger than a house, with its own tower, flag, front
// steps, and double doors, so it reads as the important building at a
// glance rather than just a scaled-up house.
function makeTownHall() {
  const g = new THREE.Group();
  const wall = 0xFFF6E4, roofColor = 0xD9584C, trim = 0x2C6CA6;

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 1.3, 2.0),
    new THREE.MeshStandardMaterial({ color: wall, roughness: 0.85 })
  );
  base.position.y = 0.65;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  const baseRoofGeo = new THREE.ConeGeometry(1.75, 0.9, 4);
  baseRoofGeo.rotateY(Math.PI / 4);
  const baseRoofSide = 1.75 * Math.SQRT2;
  const baseRoof = new THREE.Mesh(baseRoofGeo, new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.6 }));
  baseRoof.scale.set(2.4 / baseRoofSide, 1, 2.0 / baseRoofSide);
  baseRoof.position.y = 1.3 + 0.45;
  baseRoof.castShadow = true;
  g.add(baseRoof);

  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.55, 1.4, 16),
    new THREE.MeshStandardMaterial({ color: wall, roughness: 0.85 })
  );
  tower.position.y = 1.3 + 0.7;
  tower.castShadow = true;
  g.add(tower);

  const towerRoof = new THREE.Mesh(
    new THREE.ConeGeometry(0.62, 0.75, 16),
    new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.6 })
  );
  towerRoof.position.y = 1.3 + 1.4 + 0.375;
  towerRoof.castShadow = true;
  g.add(towerRoof);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8),
    new THREE.MeshStandardMaterial({ color: 0x8B5E34 })
  );
  pole.position.y = 1.3 + 1.4 + 0.75 + 0.25;
  g.add(pole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.18),
    new THREE.MeshStandardMaterial({ color: 0xFFC93C, side: THREE.DoubleSide })
  );
  flag.position.set(0.15, 1.3 + 1.4 + 0.75 + 0.42, 0);
  g.add(flag);

  const steps = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.12, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xE8DCC8, roughness: 0.9 })
  );
  steps.position.set(0, 0.06, 1.15);
  steps.receiveShadow = true;
  g.add(steps);

  const doorMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.7 });
  [-1, 1].forEach((side) => {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.5, 0.05), doorMat);
    door.position.set(side * 0.16, 0.26, 1.01);
    g.add(door);
  });

  const winTex = makeWindowTexture('#ffffff', '#BEE7FB');
  [-1, 1].forEach((side) => {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ map: winTex }));
    win.position.set(side * 0.85, 0.75, 1.011);
    g.add(win);
  });

  return g;
}

function makeBench() {
  const g = new THREE.Group();
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x8B5E34, roughness: 0.85 });
  const woodLight = new THREE.MeshStandardMaterial({ color: 0xC9975B, roughness: 0.8 });
  // Long enough to actually use its 2x1 footprint — three leg pairs (not
  // just the two end pairs a short bench needs) so a seat this long doesn't
  // look like it'd sag in the middle.
  [-0.7, 0, 0.7].forEach((x) => {
    [-1, 1].forEach((side) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.06), woodDark);
      leg.position.set(x, 0.16, side * 0.12);
      leg.castShadow = true;
      g.add(leg);
    });
  });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.32), woodLight);
  seat.position.y = 0.34;
  seat.castShadow = true;
  seat.receiveShadow = true;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.32, 0.06), woodLight);
  back.position.set(0, 0.54, -0.13);
  back.rotation.x = -0.15;
  back.castShadow = true;
  g.add(back);
  return g;
}

// `includeBase` controls the raised rim+mound bed underneath the plants.
// The real map placement (and the placement-mode ghost, which should
// preview the real thing) build with it off — the user found the raised
// bed "awkward" sitting on top of the already-grassy map ground, so on the
// map the flowers/grass just plant straight into the lawn. The Structures
// tab's shop card keeps it on, since there the bed is what gives the
// plants context against the card's plain backdrop — see
// STRUCTURE_MODELS.garden's separate `build` vs `previewBuild`.
function makeGardenPatch(options) {
  const includeBase = !options || options.includeBase !== false;
  const g = new THREE.Group();
  let BASE_Y = 0;

  if (includeBase) {
    // A flat, single-color grassy bed (no darker rim layer) with a soft
    // alpha-faded edge — same technique and reasoning as the Beach's sand
    // (see makeFadeRectTexture): a solid core with the fade living only in
    // the margin beyond it, so the bed blends into the shop card's own
    // backdrop instead of stopping in a hard rectangle. This only ever
    // appears in the Structures tab's preview (see previewBuild below) —
    // it isn't scaled by STRUCTURE_MAP_SCALE the way the map version would
    // be, so there's no need to under-size it the way the Beach's plane is.
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshStandardMaterial({
        map: makeFadeRectTexture(256, 256, 24, 24, 232, 232, 0x5FC97D),
        transparent: true, roughness: 0.9, depthWrite: false,
      })
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = 0.01;
    bed.receiveShadow = true;
    g.add(bed);
    BASE_Y = 0.02;
  }

  // Flower positions are needed before the grass carpet below (so grass can
  // leave a clearing around each one) — the flowers themselves are actually
  // built further down, after the grass. Spread across the full square bed.
  const flowerSpots = [
    [-0.9, 0.85], [-0.25, 0.9], [0.5, 0.8], [0.95, 0.55],
    [-1.0, 0.05], [0.1, 0.15], [0.85, -0.1],
    [-0.8, -0.65], [-0.05, -0.8], [0.65, -0.75], [1.0, -0.4],
    [-0.4, -0.3],
  ];

  // Tall grass jam-packs every part of the bed that isn't a flower's own
  // clearing — a tight grid (not just a fine one) across the whole 3x3 area,
  // two overlapping blades per grid point so the cones' footprints actually
  // touch/overlap instead of leaving visible gaps, jittered per-blade in
  // position/rotation/height, with any grid point too close to a flower
  // skipped so the blooms stay visible.
  const tuftMat = new THREE.MeshStandardMaterial({ color: 0x4CAF6D, roughness: 0.85 });
  const TUFT_HEIGHT = 0.24;
  const GRASS_STEP = 0.09;
  const FLOWER_CLEARANCE = 0.2;
  for (let x = -1.15; x <= 1.15; x += GRASS_STEP) {
    for (let z = -1.15; z <= 1.15; z += GRASS_STEP) {
      const nearFlower = flowerSpots.some(([fx, fz]) => Math.hypot(x - fx, z - fz) < FLOWER_CLEARANCE);
      if (nearFlower) continue;
      for (let i = 0; i < 2; i++) {
        const jx = x + (Math.random() - 0.5) * GRASS_STEP * 0.9;
        const jz = z + (Math.random() - 0.5) * GRASS_STEP * 0.9;
        const h = TUFT_HEIGHT * (0.75 + Math.random() * 0.5);
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.026, h, 4), tuftMat);
        blade.position.set(jx, BASE_Y + h / 2, jz);
        blade.rotation.x = (Math.random() - 0.5) * 0.4;
        blade.rotation.z = (Math.random() - 0.5) * 0.4;
        g.add(blade);
      }
    }
  }

  // Flowers cycle through three shapes for variety — a simple round bloom,
  // a flattened daisy with a contrasting yellow center, and a tulip bud —
  // spread across the whole rectangular bed instead of clustered in a ring.
  const bloomColors = [0xFF6FA8, 0xFFC93C, 0xB47EE5, 0xFF9F5C, 0xFFFFFF, 0xFF5C7A];
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x3E9E5C, roughness: 0.85 });
  const kinds = ['round', 'daisy', 'tulip'];
  flowerSpots.forEach(([x, z], i) => {
    const bloomMat = new THREE.MeshStandardMaterial({ color: bloomColors[i % bloomColors.length], roughness: 0.65 });
    const stemH = 0.24 + Math.random() * 0.08;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.026, stemH, 6), stemMat);
    stem.position.set(x, BASE_Y + stemH / 2, z);
    g.add(stem);
    const topY = BASE_Y + stemH;
    const kind = kinds[i % kinds.length];
    if (kind === 'round') {
      const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.078, 10, 8), bloomMat);
      bloom.position.set(x, topY, z);
      bloom.castShadow = true;
      g.add(bloom);
    } else if (kind === 'daisy') {
      const petals = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), bloomMat);
      petals.scale.set(1, 0.32, 1);
      petals.position.set(x, topY, z);
      petals.castShadow = true;
      g.add(petals);
      const center = new THREE.Mesh(
        new THREE.SphereGeometry(0.036, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xFFD93C, roughness: 0.6 })
      );
      center.position.set(x, topY + 0.02, z);
      g.add(center);
    } else {
      const bud = new THREE.Mesh(new THREE.ConeGeometry(0.054, 0.12, 6), bloomMat);
      bud.position.set(x, topY + 0.04, z);
      bud.castShadow = true;
      g.add(bud);
    }
  });

  return g;
}

// A festive sign face — canvas-painted so it reads as an actual sign
// rather than a plain colored plane, same technique as makeWindowTexture.
// A glowing marquee instead of a painted wood sign — a dark panel with the
// text drawn twice (once soft/blurred via shadowBlur for the neon halo,
// once crisp on top) so it reads as lit up rather than just colored.
function makePartyHallSignTexture() {
  return makeCanvasTexture(260, 100, (ctx, w, h) => {
    ctx.fillStyle = '#180E22';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#FF3FB0';
    ctx.lineWidth = 5;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.font = 'bold 46px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#FF3FB0';
    ctx.shadowBlur = 22;
    ctx.fillStyle = '#FF6FD8';
    ctx.fillText('PARTY!', w / 2, h / 2 + 2);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FFEBFA';
    ctx.fillText('PARTY!', w / 2, h / 2 + 2);
  });
}

// A real building — box walls, a pyramid roof sized to the wall footprint
// exactly (same no-overhang trick as makeHouse/makeTownHall), double doors,
// windows, a painted sign over the entrance, and a confetti cannon mounted
// on the front roof slope with a burst of confetti frozen mid-air above it.
function makePartyHall() {
  const g = new THREE.Group();
  // A richer, moodier palette than the old pastel-cottage pink — a deep
  // club purple wall, a brighter purple roof (same family, lighter so the
  // two planes still read as distinct surfaces instead of merging into one
  // silhouette), near-black glossy doors/windows, and a hot-pink neon
  // accent color used for the trim strip, window frames, and the sign glow.
  const wall = 0x5A2A78, roofColor = 0x8347AD, neon = 0xFF3FB0, dark = 0x1C1620;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.85, 1.4),
    new THREE.MeshStandardMaterial({ color: wall, roughness: 0.75 })
  );
  body.position.y = 0.42;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const roofGeo = new THREE.ConeGeometry(1.25, 0.7, 4);
  roofGeo.rotateY(Math.PI / 4);
  const roofSide = 1.25 * Math.SQRT2;
  const roofMesh = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.6 }));
  roofMesh.scale.set(1.7 / roofSide, 1, 1.4 / roofSide);
  roofMesh.position.y = 0.85 + 0.35;
  roofMesh.castShadow = true;
  g.add(roofMesh);

  // A thin neon strip along the top of the front wall, just under the
  // roofline — the first hint that this isn't a cottage.
  const neonMat = new THREE.MeshStandardMaterial({ color: neon, roughness: 0.3, emissive: neon, emissiveIntensity: 0.5 });
  const neonStrip = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.035, 0.02), neonMat);
  neonStrip.position.set(0, 0.81, 0.711);
  g.add(neonStrip);

  // Glossy black double doors, centered — a "hall" gets a grander entrance
  // than a house's single door.
  const doorMat = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.25, metalness: 0.2 });
  [-1, 1].forEach((side) => {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.46, 0.05), doorMat);
    door.position.set(side * 0.14, 0.23, 0.71);
    g.add(door);
  });

  // A black canopy over the entrance with a neon underline — the kind of
  // awning a club has over its door, not a house.
  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.05, 0.32),
    new THREE.MeshStandardMaterial({ color: dark, roughness: 0.6 })
  );
  canopy.position.set(0, 0.57, 0.84);
  canopy.rotation.x = -0.08;
  canopy.castShadow = true;
  g.add(canopy);
  const canopyEdge = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.03, 0.02), neonMat);
  canopyEdge.position.set(0, 0.545, 0.99);
  canopyEdge.rotation.x = -0.08;
  g.add(canopyEdge);

  // Velvet-rope stanchions flanking the entrance — gold posts with a red
  // rope strung between them, the single most "club" prop there is.
  const postMat = new THREE.MeshStandardMaterial({ color: 0xE8C147, roughness: 0.3, metalness: 0.5 });
  const stanchionXs = [-0.42, 0.42];
  stanchionXs.forEach((x) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.26, 10), postMat);
    post.position.set(x, 0.13, 0.92);
    post.castShadow = true;
    g.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), postMat);
    cap.position.set(x, 0.27, 0.92);
    g.add(cap);
  });
  const rope = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, stanchionXs[1] - stanchionXs[0], 8),
    new THREE.MeshStandardMaterial({ color: 0xB3283F, roughness: 0.6 })
  );
  rope.rotation.z = Math.PI / 2;
  rope.position.set(0, 0.22, 0.92);
  g.add(rope);

  // Tinted "club glass" windows flanking the doors — dark smoky panes in a
  // neon-pink frame instead of the usual pale, see-through house window.
  const winTex = makeWindowTexture('#FF3FB0', '#2A1B33');
  [-1, 1].forEach((side) => {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ map: winTex }));
    win.position.set(side * 0.62, 0.58, 0.711);
    g.add(win);
  });

  // A glowing marquee sign mounted on top of the canopy — this is what
  // makes it read as a specific place instead of a generic box with a
  // roof, now styled as neon signage instead of a painted wood plank.
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.23),
    new THREE.MeshBasicMaterial({ map: makePartyHallSignTexture() })
  );
  sign.position.set(0, 0.72, 0.87);
  sign.rotation.x = -0.08;
  g.add(sign);

  // A confetti cannon mounted on the front roof slope — the tube sits
  // toward the left, aimed diagonally up and to the right, and the
  // confetti sprays outward from its mouth continuing along that same
  // aim (a real burst trajectory, not just scattered symmetrically around
  // the tube). cannonBase/cannonMouth are the tube's two real endpoints —
  // its length, position, and rotation are all derived from them, and the
  // confetti's own spray direction/origin is derived from the same mouth
  // point + aim vector, so the two pieces always agree with each other
  // instead of being eyeballed into place separately.
  const cannonBase = new THREE.Vector3(-0.6, 0.98, 0.5);
  const cannonMouth = new THREE.Vector3(0.05, 1.32, 0.62);
  const cannonAim = new THREE.Vector3().subVectors(cannonMouth, cannonBase);
  const cannonLength = cannonAim.length();
  const cannonMid = new THREE.Vector3().addVectors(cannonBase, cannonMouth).multiplyScalar(0.5);

  // CylinderGeometry's length runs along local Y by default, with the
  // wider radius (the mouth) at -Y; rotating it 90° about X moves that
  // axis to local Z, at -Z — which is the axis Object3D.lookAt() aims, so
  // the mesh's wide "mouth" end faces cannonMouth once we look at it.
  const cannonGeo = new THREE.CylinderGeometry(0.045, 0.095, cannonLength, 10, 1, true);
  cannonGeo.rotateX(Math.PI / 2);
  const cannon = new THREE.Mesh(
    cannonGeo,
    new THREE.MeshStandardMaterial({ color: 0xE8C147, roughness: 0.35, metalness: 0.4, side: THREE.DoubleSide })
  );
  cannon.position.copy(cannonMid);
  cannon.lookAt(cannonMouth);
  cannon.castShadow = true;
  g.add(cannon);

  // A little collar at the mouth reads better up close than the bare open
  // cylinder edge — same material, sitting right at the tip.
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.095, 0.014, 8, 14),
    new THREE.MeshStandardMaterial({ color: 0xFFDD70, roughness: 0.3, metalness: 0.4 })
  );
  collar.position.copy(cannonMouth);
  collar.lookAt(cannonBase);
  g.add(collar);

  // Confetti sprays outward from the mouth along the cannon's own aim
  // direction, widening into a cone the further out it goes, instead of
  // surrounding the mouth evenly — this is what actually reads as "the
  // tube shot this," rather than confetti that just happens to float
  // nearby.
  const aimDir = cannonAim.clone().normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const spreadA = new THREE.Vector3().crossVectors(aimDir, worldUp).normalize();
  const spreadB = new THREE.Vector3().crossVectors(aimDir, spreadA).normalize();

  const confettiColors = [0xFF6FA8, 0xFFC93C, 0x7FCDB4, 0xB47EE5, 0xFF9F5C];
  for (let i = 0; i < 22; i++) {
    const piece = new THREE.Mesh(
      new THREE.PlaneGeometry(0.045, 0.045),
      new THREE.MeshStandardMaterial({
        color: confettiColors[i % confettiColors.length], roughness: 0.6, side: THREE.DoubleSide,
      })
    );
    const t = Math.random(); // 0 = right at the mouth, 1 = furthest out
    const forward = 0.05 + t * 0.5;
    const spread = 0.03 + t * 0.32;
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spread;
    piece.position.copy(cannonMouth)
      .addScaledVector(aimDir, forward)
      .addScaledVector(spreadA, Math.cos(angle) * radius)
      .addScaledVector(spreadB, Math.sin(angle) * radius + radius * 0.4); // biased slightly upward, like it's still falling into place rather than raining straight down
    piece.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    g.add(piece);
  }

  return g;
}

// Helper for the fountain's carved stonework below — builds a Mesh from a
// list of (radius, y) profile points lathed around the vertical axis, the
// same technique real stone-turned balusters and bowls are actually shaped
// by, so these read as sculpted rather than stacked cylinders.
function latheMesh(points, material, segments) {
  const profile = points.map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.Mesh(new THREE.LatheGeometry(profile, segments || 20), material);
}

// A European plaza-style tiered fountain: a stepped stone plinth, a wide
// lower basin with carved rim spouts trickling into it, an ornate baluster
// column, a smaller upper basin, and a small robed statue crowning the very
// top, holding the urn the water actually pours from into the basin below.
// Every curved surface is a LatheGeometry profile rather than a plain
// cylinder stack, which is what actually reads as "sculpted" instead of
// "turned on a lathe badly."
function makeFountain() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xE4E1D8, roughness: 0.75 });
  const stoneDark = new THREE.MeshStandardMaterial({ color: 0xB7B2A6, roughness: 0.85 });
  const water = new THREE.MeshStandardMaterial({ color: 0x6FC7E8, roughness: 0.3, transparent: true, opacity: 0.88 });
  const streamMat = new THREE.MeshStandardMaterial({ color: 0x8FDCF2, roughness: 0.25, transparent: true, opacity: 0.75 });

  // Stepped plinth — two stacked discs of decreasing radius, the stone
  // steps a real plaza fountain sits on.
  const step1 = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.58, 0.08, 24), stoneDark);
  step1.position.y = 0.04;
  step1.receiveShadow = true;
  g.add(step1);
  const step2 = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.5, 0.08, 24), stone);
  step2.position.y = 0.12;
  step2.castShadow = true;
  step2.receiveShadow = true;
  g.add(step2);

  // Lower basin — flares out from a narrow foot to its widest point, then
  // curls back in to form the rim lip that actually holds the water.
  const lowerBowl = latheMesh([
    [0.08, 0.00], [0.20, 0.02], [0.38, 0.06], [0.46, 0.12], [0.40, 0.17], [0.35, 0.19],
  ], stone, 24);
  lowerBowl.position.y = 0.16;
  lowerBowl.castShadow = true;
  lowerBowl.receiveShadow = true;
  g.add(lowerBowl);

  const lowerWaterY = 0.16 + 0.14;
  const lowerWater = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.03, 24), water);
  lowerWater.position.y = lowerWaterY;
  g.add(lowerWater);

  // Carved rim spouts around the lower basin's outer edge, each trickling
  // a short strand of water — the small sculpted detail real plaza
  // fountains are covered in.
  const spoutCount = 6;
  for (let i = 0; i < spoutCount; i++) {
    const a = (i / spoutCount) * Math.PI * 2;
    const rx = Math.cos(a) * 0.42, rz = Math.sin(a) * 0.42;
    const nub = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), stoneDark);
    nub.position.set(rx, 0.16 + 0.1, rz);
    g.add(nub);
    const drip = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.009, 0.05, 6), water);
    drip.position.set(rx, 0.16 + 0.07, rz);
    g.add(drip);
  }

  // Ornate central baluster — the classic vase-bellied pedestal every
  // tiered fountain has, rising from the basin floor up to the upper bowl.
  const baluster = latheMesh([
    [0.09, 0.00], [0.115, 0.03], [0.06, 0.09], [0.085, 0.14],
    [0.13, 0.19], [0.075, 0.26], [0.065, 0.32], [0.085, 0.34],
  ], stone, 16);
  const balusterY = 0.18;
  baluster.position.y = balusterY;
  baluster.castShadow = true;
  g.add(baluster);

  // Upper basin — a smaller echo of the lower bowl's profile.
  const midBowl = latheMesh([
    [0.04, 0.00], [0.12, 0.02], [0.20, 0.05], [0.22, 0.09], [0.18, 0.13], [0.15, 0.145],
  ], stone, 20);
  const midBowlY = balusterY + 0.34;
  midBowl.position.y = midBowlY;
  midBowl.castShadow = true;
  g.add(midBowl);

  const midWaterY = midBowlY + 0.10;
  const midWater = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.025, 20), water);
  midWater.position.y = midWaterY;
  g.add(midWater);

  // A small baluster continuing up to the statue's plinth.
  const topBaluster = latheMesh([
    [0.04, 0.00], [0.05, 0.025], [0.025, 0.07], [0.035, 0.10], [0.045, 0.12],
  ], stone, 14);
  const topBalusterY = midBowlY + 0.145;
  topBaluster.position.y = topBalusterY;
  topBaluster.castShadow = true;
  g.add(topBaluster);

  // A small carved figure crowning the fountain, in place of a plain
  // finial ball — a robed, featureless silhouette (no face; at this scale
  // and viewing angle a "sculpted person" reads better as a smooth classical
  // shape than as tiny cartoon eyes on a statue), arms spread outward and
  // raised, with an urn floating above its head as the water source. Sized
  // boldly and with the arms held OUT to the sides rather than clasped in
  // toward the center — this game's camera looks down at the whole village
  // from a fixed, fairly steep angle, so a figure with its arms held close
  // to its body reads as a featureless blob from above; arms that actually
  // project outward past the robe's own silhouette are what make it
  // legible as "a person" from that angle. Same stone material as the rest
  // of the carved basin/baluster work, so it reads as one continuous piece
  // of stonework rather than a separate statue bolted on.
  const statueBase = topBalusterY + 0.12;
  const statue = new THREE.Group();

  const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.075, 0.13, 12), stone);
  robe.position.y = statueBase + 0.065;
  robe.castShadow = true;
  statue.add(robe);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.042, 14, 10), stone);
  head.position.y = statueBase + 0.13 + 0.042;
  head.castShadow = true;
  statue.add(head);

  // Arms raised and spread outward (not converging toward the center) so
  // they visibly clear the robe's own silhouette from directly above —
  // built with the same shoulder-to-hand limb helper the avatar's own arms
  // use, just much smaller and stone-colored.
  const shoulderY = statueBase + 0.11;
  [-1, 1].forEach((side) => {
    const shoulder = new THREE.Vector3(side * 0.039, shoulderY, 0);
    const hand = new THREE.Vector3(side * 0.075, statueBase + 0.155, 0.018);
    statue.add(limbSegment(shoulder, hand, 0.021, 0.014, stone, 8));
  });

  const urnY = statueBase + 0.13 + 0.084 + 0.03;
  const urn = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.034, 0.058, 10), stone);
  urn.position.y = urnY;
  urn.castShadow = true;
  statue.add(urn);

  g.add(statue);

  // The cascade now pours from the urn's mouth rather than a plain finial —
  // a tapered stream falling from the statue into the upper basin's water.
  const streamTop = urnY + 0.02, streamBottom = midWaterY + 0.012;
  const stream = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.03, streamTop - streamBottom, 8),
    streamMat
  );
  stream.position.y = (streamTop + streamBottom) / 2;
  g.add(stream);

  g.userData.water = lowerWater;
  return g;
}

// A flat sand rectangle (no raised bed, walkable like the garden patch)
// with two beach chairs and two umbrellas. Sized conservatively smaller
// than its 5x3 grid footprint on purpose — every structure gets visually
// scaled up by STRUCTURE_MAP_SCALE (1.3x) once actually placed, and at
// that scale a sand rect built right up to the 5x3 edge would overflow
// into whatever's in the neighboring cells; building it ~30% smaller here
// means the scaled-up result still lands just inside its reserved footprint.
// A soft-edged sand texture — one solid tan rectangle inset from the
// canvas edge, blurred so its border feathers out to fully transparent
// instead of stopping in a hard line. Square canvas on a non-square plane
// stretches that blur into a matching rectangular fade automatically —
// same trick as using a square texture for a circular gradient elsewhere.
// The canvas is sized so a precise inner rectangle (x0..x1, y0..y1) maps to
// exactly the beach's real 5x3 footprint once the plane this is painted on
// gets scaled up by STRUCTURE_MAP_SCALE at placement — that whole rectangle
// is filled solid, no blur, no softening. Only the margin *outside* it (the
// extra plane size beyond the 5x3, reaching into the neighboring squares)
// fades: straight gradients along the four edges, radial gradients at the
// four corners so the two meet without a seam. This is deliberately not a
// blur — a blur softens equally on both sides of whatever edge it's
// applied to, which would have eaten into the "solid" area; explicit
// gradients let the fade start exactly at the footprint's true edge.
// A canvas texture with a hard-edged solid-color rectangle (x0..x1, y0..y1)
// and a soft alpha fade in the margin outside it — straight gradients along
// the four edges, radial gradients at the four corners so the two meet
// without a seam. This is deliberately not a blur — a blur softens equally
// on both sides of whatever edge it's applied to, which would eat into the
// "solid" rectangle; explicit gradients let the fade start exactly at its
// true edge instead. Used for anything that should blend into the ground
// around it instead of stopping in a hard rectangle — currently the
// Beach's sand and the Garden Patch's preview-only bed.
function makeFadeRectTexture(w, h, x0, y0, x1, y1, colorHex) {
  const c = new THREE.Color(colorHex);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const opaque = `rgba(${rgb},1)`, clear = `rgba(${rgb},0)`;
  return makeCanvasTexture(w, h, (ctx) => {
    ctx.fillStyle = opaque;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    let g = ctx.createLinearGradient(0, y0, 0, 0);
    g.addColorStop(0, opaque); g.addColorStop(1, clear);
    ctx.fillStyle = g; ctx.fillRect(x0, 0, x1 - x0, y0); // top

    g = ctx.createLinearGradient(0, y1, 0, h);
    g.addColorStop(0, opaque); g.addColorStop(1, clear);
    ctx.fillStyle = g; ctx.fillRect(x0, y1, x1 - x0, h - y1); // bottom

    g = ctx.createLinearGradient(x0, 0, 0, 0);
    g.addColorStop(0, opaque); g.addColorStop(1, clear);
    ctx.fillStyle = g; ctx.fillRect(0, y0, x0, y1 - y0); // left

    g = ctx.createLinearGradient(x1, 0, w, 0);
    g.addColorStop(0, opaque); g.addColorStop(1, clear);
    ctx.fillStyle = g; ctx.fillRect(x1, y0, w - x1, y1 - y0); // right

    const r = Math.max(x0, y0);
    [[x0, y0, 0, 0], [x1, y0, x1, 0], [x0, y1, 0, y1], [x1, y1, x1, y1]].forEach(([cx, cy, qx, qy]) => {
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, opaque); rg.addColorStop(1, clear);
      ctx.fillStyle = rg;
      ctx.fillRect(qx, qy, qx === 0 ? x0 : w - x1, qy === 0 ? y0 : h - y1);
    });
  });
}

// Calibrated so the solid (non-faded) rectangle maps to exactly the
// beach's real 5x3 footprint once STRUCTURE_MAP_SCALE scales the plane
// this is painted on — see makeBeach().
function makeSandFadeTexture() {
  return makeFadeRectTexture(320, 226, 43, 42, 277, 184, 0xF2D9A0);
}

// Same solid-core world size as makeSandFadeTexture (so the shop card still
// shows "a real 5x3 beach," not a shrunken one) but mapped onto a smaller
// 4.4x3.0 plane instead of 5.25x3.7 — a much tighter fade margin, sized for
// a card's small backdrop disc rather than for blending into open terrain.
function makePreviewSandFadeTexture() {
  return makeFadeRectTexture(320, 218, 20, 25, 300, 193, 0xF2D9A0);
}

// `preview` shrinks the fade margin (but not the solid core) — the map
// version needs a generous margin so the fade genuinely reaches into
// neighboring squares, but that same margin is what forces the Structures
// tab's shop card to zoom way out to avoid cropping/washing out against its
// small backdrop disc; the card doesn't need the real coastline-blending
// margin at all, just enough of a fade to not look hard-edged.
function makeBeach(options) {
  const preview = !!(options && options.preview);
  const g = new THREE.Group();

  // Flush with the ground and one uniform sand color (no darker rim layer)
  // — a flat plane instead of the old raised two-tone box. The map version
  // is sized bigger than the true 5x3 footprint on purpose:
  // makeSandFadeTexture()'s solid (non-faded) region is calibrated to land
  // exactly on the real 5x3 once STRUCTURE_MAP_SCALE scales this up, and
  // the extra plane size beyond that is where the actual fade happens, out
  // into the neighboring squares — not a softened edge eating into the 5x3
  // itself. The preview version keeps the same solid core size but with a
  // much smaller margin around it (see makePreviewSandFadeTexture below).
  const sandGeo = preview ? new THREE.PlaneGeometry(4.4, 3.0) : new THREE.PlaneGeometry(5.25, 3.7);
  const sandTex = preview ? makePreviewSandFadeTexture() : makeSandFadeTexture();
  const sand = new THREE.Mesh(
    sandGeo,
    new THREE.MeshStandardMaterial({
      map: sandTex, transparent: true, roughness: 0.95, depthWrite: false,
    })
  );
  sand.rotation.x = -Math.PI / 2;
  sand.position.y = 0.01;
  sand.receiveShadow = true;
  g.add(sand);
  const SAND_Y = 0.02;

  const frameMat = new THREE.MeshStandardMaterial({ color: 0xC9975B, roughness: 0.8 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xEDEDE8, roughness: 0.55 });

  // A reclining lounger — a seat plank and an angled-back plank on a
  // simple wood frame, low to the sand.
  function makeLounger(color) {
    const group = new THREE.Group();
    const fabric = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
    // Pad height raised 0.09 -> 0.19 on 2026-09-28. A seated character's
    // underside sits 0.228 (world) above their own feet — measured, see
    // seatedBodyDrop() — so a pad at 0.09 local (0.117 world) was BELOW the
    // lowest a body can physically sit. The sit-height math compensates by
    // lowering the root, but that would have needed y = -0.111 (legs through
    // the sand), so its max(0, ...) clamped to zero and everyone floated
    // 0.111 above the pad. Raising the pad is the fix that doesn't require
    // burying anyone: 0.19 local = 0.247 world, comfortably clear of the
    // 0.228 underside, and still well below the bench's 0.34 so a lounger
    // still reads as the lower, loungier seat. Backrest and legs move with
    // it — the legs have to actually reach the sand.
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.025, 0.2), fabric);
    seat.position.y = 0.19;
    seat.rotation.x = -0.2;
    seat.castShadow = true;
    group.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.2), fabric);
    back.position.set(-0.18, 0.26, -0.02);
    back.rotation.x = -1.15;
    back.castShadow = true;
    group.add(back);
    [-1, 1].forEach((side) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.19, 6), frameMat);
      leg.position.set(side * 0.16, 0.095, 0.06);
      group.add(leg);
    });
    return group;
  }

  // A planted umbrella — pole, a coned canopy, and a small finial tip.
  function makeUmbrella(color) {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.5, 8), poleMat);
    pole.position.y = 0.25;
    pole.castShadow = true;
    group.add(pole);
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.2, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
    canopy.position.y = 0.5 + 0.05;
    canopy.castShadow = true;
    group.add(canopy);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), poleMat);
    tip.position.y = 0.5 + 0.15;
    group.add(tip);
    return group;
  }

  const scene1 = new THREE.Group();
  scene1.add(makeLounger(0xFF6FA8));
  const umbrella1 = makeUmbrella(0xFF6FA8);
  umbrella1.position.set(-0.42, 0, -0.32);
  scene1.add(umbrella1);
  scene1.position.set(-1.1, SAND_Y, 0.3);
  scene1.rotation.y = 0.35;
  g.add(scene1);

  const scene2 = new THREE.Group();
  scene2.add(makeLounger(0x6FC7E8));
  const umbrella2 = makeUmbrella(0x6FC7E8);
  umbrella2.position.set(0.42, 0, -0.32);
  scene2.add(umbrella2);
  scene2.position.set(1.15, SAND_Y, -0.35);
  scene2.rotation.y = -0.5;
  g.add(scene2);

  return g;
}

// A painted court surface — a flat plane instead of a raised bed (like the
// Garden Patch/Beach) with boundary lines, a center line/circle, and a key
// near each end, drawn on a canvas texture the same way window frames and
// signs are. Deliberately hard-edged (no soft fade like the Beach's sand)
// — a paved/painted court reads as a distinct surface with a real boundary
// line, not something that blends into the grass around it.
function makeCourtTexture() {
  return makeCanvasTexture(512, 300, (ctx, w, h) => {
    ctx.fillStyle = '#C97B4A';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#F4EAD5';
    ctx.lineWidth = 7;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.beginPath(); ctx.moveTo(w / 2, 14); ctx.lineTo(w / 2, h - 14); ctx.stroke();
    ctx.beginPath(); ctx.arc(w / 2, h / 2, 46, 0, Math.PI * 2); ctx.stroke();
    const keyW = 100, keyH = h - 28 - 60;
    ctx.strokeRect(14, (h - keyH) / 2, keyW, keyH);
    ctx.strokeRect(w - 14 - keyW, (h - keyH) / 2, keyW, keyH);
  });
}

// A hoop — pole, backboard, rim, and a stylized net — `facing` (+1/-1) is
// which way along local X the backboard/rim point, so the same builder
// works for both ends of the court just mirrored.
function makeHoop(facing) {
  const group = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xEDEDE8, roughness: 0.5, metalness: 0.3 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.85, 8), poleMat);
  pole.position.y = 0.425;
  pole.castShadow = true;
  group.add(pole);

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.24, 0.34),
    new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.4 })
  );
  board.position.set(facing * 0.06, 0.78, 0);
  board.castShadow = true;
  group.add(board);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.008, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0xD9622C, roughness: 0.5 })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.set(facing * 0.16, 0.68, 0);
  group.add(rim);

  const net = new THREE.Mesh(
    new THREE.ConeGeometry(0.085, 0.13, 10, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xFFFFFF, roughness: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.75,
    })
  );
  net.position.set(facing * 0.16, 0.615, 0);
  group.add(net);

  return group;
}

function makeSportsCourt() {
  const g = new THREE.Group();
  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 2.1),
    new THREE.MeshStandardMaterial({ map: makeCourtTexture(), roughness: 0.85 })
  );
  court.rotation.x = -Math.PI / 2;
  court.position.y = 0.01;
  court.receiveShadow = true;
  g.add(court);

  const hoopA = makeHoop(1);
  hoopA.position.set(-1.7, 0, 0);
  g.add(hoopA);

  const hoopB = makeHoop(-1);
  hoopB.position.set(1.7, 0, 0);
  g.add(hoopB);

  return g;
}

// `w`/`h` are the grid footprint reserved for auto-placement/spacing (see
// findFreeGridSpot) — deliberately generous so structures don't crowd each
// other. `collide` is the actual physical collider, sized to the real model
// geometry instead, so the player only bumps into the model they can see,
// not that whole reserved footprint.
const STRUCTURE_MODELS = {
  bench: { build: makeBench, w: 2, h: 1, collide: { type: 'box', hw: 0.8, hh: 0.185 } },
  // `build` (used for the real map placement and the placement-mode ghost)
  // skips the raised bed; `previewBuild` (used only by the Structures tab's
  // shop card) keeps it — see makeGardenPatch's `includeBase` param.
  // No `collide` — it's flat and walkable, like the grass around it, so the
  // player can walk straight over it instead of bumping an invisible wall.
  // It still reserves its full 3x3 footprint (via w/h) so nothing else
  // auto-places on top of it.
  garden: {
    build: () => makeGardenPatch({ includeBase: false }),
    previewBuild: () => makeGardenPatch({ includeBase: true }),
    w: 3, h: 3, collide: null,
  },
  'party-hall': { build: makePartyHall, w: 2, h: 2, collide: { type: 'box', hw: 0.9, hh: 0.75 } },
  fountain: { build: makeFountain, w: 1, h: 1, collide: { type: 'circle', r: 0.59 } },
  // `coastalOnly` is checked by isPlacementValid()/findFreeCoastalSpot() —
  // this is the only structure restricted to specific cells (the south
  // shoreline row) rather than any free spot on the board. No `collide` —
  // it's flat sand, walkable like the garden patch.
  // `coastalOrientable` lets the placement system swap w/h and rotate the
  // model 90° when it's dragged onto the east shoreline instead of the
  // south one, so it's always 5 long *along the coast* and 3 deep *into
  // the town* regardless of which shore it's on — see
  // resolveOrientedAnchor()/isPlacementValid().
  // `build` (the real map placement + the placement ghost) uses the full
  // fade margin so the sand genuinely blends into neighboring squares;
  // `previewBuild` (the shop card only) uses makeBeach({preview:true})'s
  // tighter margin instead, so the card doesn't need as drastic a
  // zoom-out to avoid cropping/washing out. `previewCameraScale` pulls the
  // shared shop camera back proportionally; `previewGroundRadius` is a
  // *separate* concern — the world-space size the ground disc needs to be
  // to sit fully beneath the sand's own real extent regardless of camera
  // distance (conflating the two at first still left the fade running
  // past a too-small disc into the card's white background). Both are
  // retuned smaller here to match the preview build's smaller extent
  // (half-diagonal ~2.66 vs the map version's ~3.21).
  beach: {
    build: makeBeach,
    previewBuild: () => makeBeach({ preview: true }),
    w: 5, h: 3, collide: null, coastalOnly: true, coastalOrientable: true,
    previewCameraScale: 2.1, previewGroundRadius: 2.85,
  },
  // No `collide` — same reasoning as the Garden Patch/Beach: it's a flat,
  // walkable painted surface, not a solid obstacle.
  'sports-court': { build: makeSportsCourt, w: 5, h: 3, collide: null },
};

// Structures read a little small next to the avatar/buildings out on the
// actual map, so placed instances (and the placement-mode ghost, which
// should preview the real size) are scaled up from their natural
// `model.build()` size — just the Structures tab's shop-card previews stay
// at 1x, since those are judged against the card, not the world.
const STRUCTURE_MAP_SCALE = 1.3;

// ---- Grid — the village is a GRID_SIZE x GRID_SIZE board of 1-unit cells. Every building
// occupies a rectangular block of cells (a house is 3x3); the player's
// avatar always moves and stops on whole cells, never freely. `col`/`row`
// are grid indices (0..GRID_SIZE-1); world x/z are what Three.js actually
// renders, with the board centered on the origin.
const GRID_SIZE = 18;
const CELL = 1.0;
const GRID_HALF = (GRID_SIZE * CELL) / 2;
const BORDER_FAR = 70; // how deep the water runs — well past where fog (far=58, see initVillageScene) has already faded it to sky color
const BORDER_CORNER = 6; // how far the water reaches sideways past the board edge, just enough to cover the corner where the two bands meet

function gridToWorld(col, row) {
  return {
    x: (col - (GRID_SIZE - 1) / 2) * CELL,
    z: (row - (GRID_SIZE - 1) / 2) * CELL,
  };
}

function footprintCenterWorld(col, row, w, h) {
  return gridToWorld(col + (w - 1) / 2, row + (h - 1) / 2);
}

// Inverse of gridToWorld, rounded to the nearest cell and clamped onto the
// board — used to reserve the avatar's current cell in the occupancy grid
// even though its real position (see getVillageSpawnPoint) is continuous,
// not grid-aligned.
function worldToGridCell(x, z) {
  const col = Math.round(x / CELL + (GRID_SIZE - 1) / 2);
  const row = Math.round(z / CELL + (GRID_SIZE - 1) / 2);
  return {
    col: Math.max(0, Math.min(GRID_SIZE - 1, col)),
    row: Math.max(0, Math.min(GRID_SIZE - 1, row)),
  };
}

// Where the avatar should appear on entering the Village screen: wherever it
// last stood (state.villagePos, persisted by teardownVillageScene), or the
// original fixed spawn point (just south of the town hall) the very first
// time. `col`/`row` are the nearest grid cell, used only to reserve this
// spot in the occupancy grid so nothing can be placed on top of it; `x`/`z`
// are the exact continuous position the avatar is actually placed at.
function getVillageSpawnPoint() {
  const mid = Math.floor((GRID_SIZE - 3) / 2);
  const defaultCol = mid + 1, defaultRow = mid + 3;
  if (state.villagePos) {
    const cell = worldToGridCell(state.villagePos.x, state.villagePos.z);
    return { col: cell.col, row: cell.row, x: state.villagePos.x, z: state.villagePos.z };
  }
  const world = gridToWorld(defaultCol, defaultRow);
  return { col: defaultCol, row: defaultRow, x: world.x, z: world.z };
}

function makeOccupancyGrid() {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(false));
}

function isBlockFree(occupancy, col, row, w, h) {
  if (col < 0 || row < 0 || col + w > GRID_SIZE || row + h > GRID_SIZE) return false;
  for (let r = row; r < row + h; r++) {
    for (let c = col; c < col + w; c++) {
      if (occupancy[r][c]) return false;
    }
  }
  return true;
}

function markOccupied(occupancy, col, row, w, h) {
  for (let r = row; r < row + h; r++) {
    for (let c = col; c < col + w; c++) {
      occupancy[r][c] = true;
    }
  }
}

// The free w x h block closest to `centerCol`/`centerRow` (defaulting to the
// board's own center) — this is what lets bought structures (and decorative
// trees) place themselves with no manual arranging, filling outward from
// wherever the town core actually is as the village grows.
function findFreeGridSpot(occupancy, w, h, centerCol, centerRow) {
  const cx = centerCol === undefined ? (GRID_SIZE - w) / 2 : centerCol;
  const cz = centerRow === undefined ? (GRID_SIZE - h) / 2 : centerRow;
  let best = null, bestDist = Infinity;
  for (let row = 0; row <= GRID_SIZE - h; row++) {
    for (let col = 0; col <= GRID_SIZE - w; col++) {
      if (!isBlockFree(occupancy, col, row, w, h)) continue;
      const d = (col - cx) ** 2 + (row - cz) ** 2;
      if (d < bestDist) { bestDist = d; best = { col, row }; }
    }
  }
  return best;
}

// Like findFreeGridSpot, but only considers cells flush against the south
// shoreline (row + h === GRID_SIZE) — used for structures that must sit on
// the coastline (see STRUCTURE_MODELS.beach's `coastalOnly` flag).
function findFreeCoastalSpot(occupancy, w, h) {
  const row = GRID_SIZE - h;
  if (row < 0) return null;
  const cx = (GRID_SIZE - w) / 2;
  let best = null, bestDist = Infinity;
  for (let col = 0; col <= GRID_SIZE - w; col++) {
    if (!isBlockFree(occupancy, col, row, w, h)) continue;
    const d = (col - cx) ** 2;
    if (d < bestDist) { bestDist = d; best = { col, row }; }
  }
  return best;
}

// True only for a cell a structure is actually allowed to occupy: free,
// and — for coastal-only structures like the beach — flush against the
// south shoreline. Used by both placement mode's live validity check and
// layoutVillageBoard()'s legacy-migration fallback, so the two can never
// disagree about what counts as a valid spot.
function isPlacementValid(model, occupancy, col, row, rotated) {
  const w = rotated ? model.h : model.w;
  const h = rotated ? model.w : model.h;
  if (!isBlockFree(occupancy, col, row, w, h)) return false;
  if (model.coastalOnly) {
    if (rotated) {
      if (col + w !== GRID_SIZE) return false; // flush against the east shore
    } else if (row + h !== GRID_SIZE) return false; // flush against the south shore
  }
  return true;
}

// Works out which anchor cell — and, for structures that can hug either
// shoreline (currently just the Beach, via `coastalOrientable`), which
// orientation — the joystick cursor's current continuous position
// corresponds to. "South" keeps the model's natural w/h; "east" swaps them
// so the long edge runs along the vertical coast instead. This is what
// auto-aligns the structure as it's dragged from one shoreline to the
// other, rather than needing a separate rotate control.
function resolveOrientedAnchor(model, gx, gz) {
  const southCol = Math.max(0, Math.min(GRID_SIZE - model.w, Math.round(gx - (model.w - 1) / 2)));
  const southRow = Math.max(0, Math.min(GRID_SIZE - model.h, Math.round(gz - (model.h - 1) / 2)));
  if (!model.coastalOrientable) {
    return { col: southCol, row: southRow, rotated: false };
  }
  const eastW = model.h, eastH = model.w;
  const eastCol = Math.max(0, Math.min(GRID_SIZE - eastW, Math.round(gx - (eastW - 1) / 2)));
  const eastRow = Math.max(0, Math.min(GRID_SIZE - eastH, Math.round(gz - (eastH - 1) / 2)));
  const southTouches = southRow + model.h === GRID_SIZE;
  const eastTouches = eastCol + eastW === GRID_SIZE;
  if (eastTouches && !southTouches) {
    return { col: eastCol, row: eastRow, rotated: true };
  }
  return { col: southCol, row: southRow, rotated: false };
}

// The town hall stands alone at the true center of the board (its own
// landmark, no trees crowding it — see placeVillageWorld()'s tree scatter),
// while the three homes are packed tightly in a row right along the
// northern border, starting on the second column (index 1) and running
// east with no gap between one footprint and the next. Each entry's `w`/`h`
// (3x3) is the reserved placement footprint, but `collide` is sized to the
// actual model (a house's real base is 1.4x1.2, a lot smaller), so the
// player only bumps into the building itself, not that whole reserved plot.
const HOUSE_ROW_COL = 1; // the second square, per the user's ask
const HOUSE_ROW_ROW = 0; // right along the northern border
const HOUSE_ROW_STEP = 3; // packed tightly — no gap between one 3-wide footprint and the next

// Shared by every 3x3 house footprint — the core row's three homes and any
// structure-triggered villager house alike — since collide is sized to a
// house's real base (1.4x1.2), not the whole reserved 3x3 plot.
const HOUSE_COLLIDE = { type: 'box', hw: 0.75, hh: 0.65 };
// Sized to the town hall's real base (2.4x2.0), same reasoning as
// HOUSE_COLLIDE — also reused by getTownHallDoorPoint() to know exactly
// where its own front doors are, in world space, for the "Enter" prompt.
const TOWN_HALL_COLLIDE = { type: 'box', hw: 1.25, hh: 1.05 };

function coreBuildingLayout() {
  const mid = Math.floor((GRID_SIZE - 3) / 2);
  return [
    { col: mid, row: mid, w: 3, h: 3, build: makeTownHall, collide: TOWN_HALL_COLLIDE },
    { col: HOUSE_ROW_COL, row: HOUSE_ROW_ROW, w: 3, h: 3, build: () => makeHouse(state.character.outfit, 0xE07856, '#3A2E22'), collide: HOUSE_COLLIDE },
    { col: HOUSE_ROW_COL + HOUSE_ROW_STEP, row: HOUSE_ROW_ROW, w: 3, h: 3, build: () => makeHouse(0xBFE0F5, 0xFFC93C, '#2C6CA6'), collide: HOUSE_COLLIDE },
    { col: HOUSE_ROW_COL + HOUSE_ROW_STEP * 2, row: HOUSE_ROW_ROW, w: 3, h: 3, build: () => makeHouse(0xFFEFC2, 0x3D8FD6, '#8A6D00'), collide: HOUSE_COLLIDE },
  ];
}

// One NPC stands just outside each of the two neighbor homes (not the
// player's own), just south of its own house facing out toward the open
// plaza — built from the same buildCharacter() model as the player so they
// read as part of the same cast, just customized differently.
function villagerNpcLayout() {
  const row = HOUSE_ROW_ROW + 3;
  return [
    {
      id: 'neighbor-hannah', col: HOUSE_ROW_COL + HOUSE_ROW_STEP + 1, row, facing: 0,
      name: 'Hannah', gender: 'female',
      character: { skin: '#FFE3C8', eyes: 'round', nose: 'wide', hairStyle: 'curly', hairColor: '#2B2118', outfit: '#E8A93C', glasses: 'round', facialHair: 'none', feminine: true, bowColor: '#C23B4E' },
    },
    {
      id: 'neighbor-caleb', col: HOUSE_ROW_COL + HOUSE_ROW_STEP * 2 + 1, row, facing: 0,
      name: 'Caleb', gender: 'male',
      character: { skin: '#F8D9B8', eyes: 'almond', nose: 'point', hairStyle: 'long', hairColor: '#8A2E2E', outfit: '#2B7A78', glasses: 'none', facialHair: 'goatee' },
    },
  ];
}

// A `build()` for one structure-triggered villager's house — colored to
// match their archetype (see VILLAGER_ARCHETYPES), otherwise the exact same
// makeHouse() shape as the three core homes.
function villagerHouseBuilder(villager) {
  const c = villager.houseColors;
  return () => makeHouse(c.wall, c.roof, c.door);
}

// Where decorative trees scatter to — spread around the board instead of
// clumped in one spot, and deliberately kept clear of the town hall (each
// point sits at least a few cells from its center) since the user wants no
// trees around it. findFreeGridSpot() (see placeVillageWorld()) nudges each
// one off its anchor if that exact cell is ever already taken.
const TREE_ANCHORS = [
  { col: 2, row: 5 }, { col: 12, row: 5 },
  { col: 1, row: 9 }, { col: 13, row: 9 },
  { col: 4, row: 12 }, { col: 10, row: 12 },
];

// Scales/offsets a buildCharacter() model the same way for anyone standing
// in the village (the player's avatar and any NPC) so they're all sized and
// grounded consistently.
function buildVillageCharacterModel(cfg) {
  const wrapper = new THREE.Group();
  const character = buildCharacter(cfg);
  wrapper.add(character);
  wrapper.scale.setScalar(VILLAGE_MODEL_SCALE);
  wrapper.position.y = -(GROUND_Y + FOOT_MARGIN) * VILLAGE_MODEL_SCALE;
  return { wrapper, character };
}

function makeGroundGridTexture() {
  const px = 32;
  const size = GRID_SIZE * px;
  const colorA = '#6FCB6F';
  const colorB = '#5EB25E';
  return makeCanvasTexture(size, size, (ctx) => {
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? colorA : colorB;
        ctx.fillRect(col * px, row * px, px, px);
      }
    }
  });
}

// A dense, slightly irregular tree wall along the north and west edges of
// the board (meeting in a filled-in northwest corner) — the board is already
// the hard edge of where the avatar can walk (see the pointerdown handler),
// so this is dressing that explains that boundary rather than new collision
// logic, but it's built past the two openings a genuine wall would need:
// no plausible line through it that skips a tree.
//
// It has to look like it never ends, with the camera fixed and never
// panning or zooming. There's deliberately no flat "forest floor" colored
// slab behind the trees — that was tried first and it created a visible
// seam where its color met the plain grass backdrop near the open corner.
// Real tree meshes read as forest by their own silhouette instead, planted
// at the same density all the way out to FOREST_DEPTH (an earlier version
// thinned the density with distance to save on tree count, but that read as
// the forest running out rather than continuing).
const FOREST_DEPTH = 14;

function buildForestWall(scene) {
  const spacing = 0.85;
  const jitter = (amt) => (Math.random() - 0.5) * amt;

  function plantNorthBand() {
    for (let z = -GRID_HALF - spacing / 2; z >= -GRID_HALF - FOREST_DEPTH; z -= spacing) {
      for (let x = -GRID_HALF - FOREST_DEPTH; x <= GRID_HALF; x += spacing + Math.random() * 0.2) {
        makeGroveTree(scene, x + jitter(0.35), z + jitter(0.35), 0.8 + Math.random() * 0.3);
      }
    }
  }
  function plantWestBand() {
    for (let x = -GRID_HALF - spacing / 2; x >= -GRID_HALF - FOREST_DEPTH; x -= spacing) {
      for (let z = -GRID_HALF - FOREST_DEPTH; z <= GRID_HALF; z += spacing + Math.random() * 0.2) {
        makeGroveTree(scene, x + jitter(0.35), z + jitter(0.35), 0.8 + Math.random() * 0.3);
      }
    }
  }

  plantNorthBand();
  plantWestBand();
}

// Water along the south and east edges (meeting in a filled-in southeast
// corner, and reaching all the way up to fill the northeast corner too —
// the northwest and southwest corners stay forest/open land, but northeast
// sits between the forest's north wall and the sea to the east, so it's
// sea) — runs out to BORDER_FAR same as the forest, so fog hides its true
// edge instead of the sea visibly stopping.
function buildWaterBorder(scene) {
  // Brighter/shinier than the rest of the toned-down palette on purpose —
  // the user asked for the sea specifically to pop more than everything
  // else, not just ride along with the general lighting increase below.
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x5DC2E8, roughness: 0.18, transparent: true, opacity: 0.92 });

  // South band: runs forever south, spans the board's width plus a bit
  // extra on the east side to meet the east band at the corner, stopping
  // at the board's own west edge so it never encroaches on the forest.
  const southWidth = GRID_SIZE * CELL + BORDER_CORNER;
  const south = new THREE.Mesh(new THREE.BoxGeometry(southWidth, 0.15, BORDER_FAR), waterMat);
  south.position.set(-GRID_HALF + southWidth / 2, -0.05, GRID_HALF + BORDER_FAR / 2);
  south.receiveShadow = true;
  scene.add(south);

  // East band: runs forever east, and its height reaches BORDER_CORNER past
  // the board on *both* the south side (to meet the south band at the
  // southeast corner) and the north side (to fill the northeast corner,
  // since the forest's north wall stops at the board's own east edge).
  const eastHeight = GRID_SIZE * CELL + BORDER_CORNER * 2;
  const east = new THREE.Mesh(new THREE.BoxGeometry(BORDER_FAR, 0.15, eastHeight), waterMat);
  east.position.set(GRID_HALF + BORDER_FAR / 2, -0.05, GRID_HALF - eastHeight / 2 + BORDER_CORNER);
  east.receiveShadow = true;
  scene.add(east);
}

// Resolves where everything on the board goes — core buildings, NPCs,
// bought structures, and decorative trees — as plain data, with no THREE
// scene involved. This is the single source of truth for the occupancy
// grid, shared by the real mesh-building pass below (placeVillageWorld) and
// by placement mode (see enterPlacementMode/confirmPlacement in the shop),
// which needs to know what's free without spinning up a scene.
//
// Bought structures carry their own col/row once placed manually; a legacy
// entry that predates manual placement (no col/row saved yet) falls back to
// the old auto-placement spot and that spot is written back onto the state
// entry so it stays put on every future layout instead of drifting.
function layoutVillageBoard(spawnCol, spawnRow, options) {
  const includeNpcs = !options || options.includeNpcs !== false;
  const occupancy = makeOccupancyGrid();

  const core = coreBuildingLayout().map((b) => {
    markOccupied(occupancy, b.col, b.row, b.w, b.h);
    return { ...b, center: footprintCenterWorld(b.col, b.row, b.w, b.h) };
  });

  const npcs = includeNpcs ? villagerNpcLayout().map((npc) => {
    markOccupied(occupancy, npc.col, npc.row, 1, 1);
    return { ...npc, center: gridToWorld(npc.col, npc.row) };
  }) : [];

  // Reserve the avatar's spawn cell (wherever it last stood — see
  // getVillageSpawnPoint) so a structure or tree can never land on top of
  // it, whether auto-placed or manually dragged there in placement mode.
  // Left marked for the rest of this function's life — unlike the old
  // behavior, nothing frees it afterward, since a structure sitting under
  // the avatar's spawn point would be just as much a problem as one on top
  // of a building.
  markOccupied(occupancy, spawnCol, spawnRow, 1, 1);

  // Structures are resolved (and marked into `occupancy`) *before* the
  // villager houses below, so a new house's free-spot search already knows
  // about every real structure standing in the village — otherwise a house
  // could land right on top of, say, an already-built Sports Court.
  //
  // `houseOccupancy` is a parallel grid that mirrors `occupancy` for
  // everything except Garden Patch: a garden is flat, walkable, and
  // decorative, so a new villager house is allowed to pave right over one
  // (the garden just tucks under it) — but never over a real footprint like
  // the Beach or Sports Court, both of which reserve their full space in
  // `occupancy` here despite having no walking `collide`.
  const houseOccupancy = makeOccupancyGrid();
  markOccupied(houseOccupancy, spawnCol, spawnRow, 1, 1);
  core.forEach((b) => markOccupied(houseOccupancy, b.col, b.row, b.w, b.h));
  npcs.forEach((npc) => markOccupied(houseOccupancy, npc.col, npc.row, 1, 1));

  const structures = [];
  state.village.forEach((s) => {
    const model = STRUCTURE_MODELS[s.type];
    if (!model) return;
    if (s.col === undefined || s.row === undefined) {
      const spot = model.coastalOnly
        ? findFreeCoastalSpot(occupancy, model.w, model.h)
        : findFreeGridSpot(occupancy, model.w, model.h);
      if (!spot) return;
      s.col = spot.col;
      s.row = spot.row;
    }
    const rotated = !!s.rotated;
    const w = rotated ? model.h : model.w;
    const h = rotated ? model.w : model.h;
    markOccupied(occupancy, s.col, s.row, w, h);
    if (s.type !== 'garden') markOccupied(houseOccupancy, s.col, s.row, w, h);
    structures.push({ s, model, col: s.col, row: s.row, rotated, center: footprintCenterWorld(s.col, s.row, w, h) });
  });

  // Structure-triggered villagers (see maybeSpawnVillager) each get their
  // own 3x3 house — placed the same lazily-resolved-then-pinned way bought
  // structures are above — plus a standing spot just south of it, same
  // offset the two fixed starting neighbors use in villagerNpcLayout. Every
  // house is built with no rotation applied (see placeVillageWorld), the
  // same as every other building in the village, so its entrance — always
  // modeled facing local +z — reads as facing south for all of them alike.
  const villagerHouses = [];
  if (includeNpcs) {
    state.villagers.forEach((v) => {
      if (v.col === undefined || v.row === undefined) {
        const spot = findFreeGridSpot(houseOccupancy, 3, 3);
        if (!spot) return;
        v.col = spot.col;
        v.row = spot.row;
      }
      markOccupied(occupancy, v.col, v.row, 3, 3);
      markOccupied(houseOccupancy, v.col, v.row, 3, 3);
      villagerHouses.push({
        v, col: v.col, row: v.row,
        build: villagerHouseBuilder(v),
        collide: HOUSE_COLLIDE,
        center: footprintCenterWorld(v.col, v.row, 3, 3),
      });
      const standSpot = findFreeGridSpot(occupancy, 1, 1, v.col + 1, v.row + 3);
      if (!standSpot) return;
      markOccupied(occupancy, standSpot.col, standSpot.row, 1, 1);
      markOccupied(houseOccupancy, standSpot.col, standSpot.row, 1, 1);
      npcs.push({ id: v.id, structureId: v.structureId, col: standSpot.col, row: standSpot.row, facing: 0, name: v.name, gender: v.gender, character: v.character, center: gridToWorld(standSpot.col, standSpot.row) });
    });
  }

  const trees = [];
  TREE_ANCHORS.forEach((anchor) => {
    const spot = findFreeGridSpot(occupancy, 1, 1, anchor.col, anchor.row);
    if (!spot) return;
    markOccupied(occupancy, spot.col, spot.row, 1, 1);
    trees.push({ col: spot.col, row: spot.row, center: footprintCenterWorld(spot.col, spot.row, 1, 1) });
  });

  return { occupancy, core, npcs, structures, trees, villagerHouses };
}

// Builds the real THREE meshes/colliders for a resolved layout and adds
// them to `scene`, returning the same occupancy/colliders shape movement
// already relies on.
function placeVillageWorld(scene, spawnCol, spawnRow, options) {
  const layout = layoutVillageBoard(spawnCol, spawnRow, options);
  const colliders = [];
  const addCollider = (center, collide, meta) => {
    const base = collide.type === 'circle'
      ? { type: 'circle', x: center.x, z: center.z, r: collide.r }
      : { type: 'box', x: center.x, z: center.z, hw: collide.hw, hh: collide.hh };
    colliders.push(meta ? Object.assign(base, meta) : base);
  };

  layout.core.forEach((b) => {
    addCollider(b.center, b.collide);
    const group = b.build();
    group.position.set(b.center.x, 0, b.center.z);
    scene.add(group);
  });

  layout.villagerHouses.forEach((h) => {
    addCollider(h.center, h.collide);
    const group = h.build();
    group.position.set(h.center.x, 0, h.center.z);
    scene.add(group);
  });

  layout.npcs.forEach((npc, npcIndex) => {
    // A live circle collider, tagged with npcId so a wandering villager's
    // own movement (see resolveVillageCollisions' exclude param, used by
    // updateNpcMovement) can filter it out from blocking itself — and kept
    // on the npc object so its x/z can be updated every frame as they walk
    // around (see animate()'s per-npc wander loop), instead of staying
    // pinned to their original standing spot forever.
    const npcCollider = { type: 'circle', x: npc.center.x, z: npc.center.z, r: NPC_RADIUS, npcId: npc.id };
    colliders.push(npcCollider);
    npc.collider = npcCollider;
    const { wrapper, character } = buildVillageCharacterModel(npc.character);
    wrapper.rotation.y = npc.facing;
    const npcRoot = new THREE.Group();
    npcRoot.position.set(npc.center.x, 0, npc.center.z);
    npcRoot.add(wrapper);
    scene.add(npcRoot);
    // Kept on the npc data itself (not just the scene graph) so animate()'s
    // talk-cycle loop can find and pose the right villager's model by id
    // while a conversation with them is open — see startTalking().
    npc.characterModel = character;
    // `npc.root`/`npc.wrapper` let animate() move and turn this villager
    // live; `npc.center` stays untouched as their fixed "home" spot to
    // wander from and return to. `npc.pos`/`npc.facingAngle` are the live,
    // continuously-updated counterparts — see updateNpcMovement().
    npc.root = npcRoot;
    npc.wrapper = wrapper;
    npc.pos = { x: npc.center.x, z: npc.center.z };
    npc.facingAngle = npc.facing;
    npc.walkPhase = 0;
    npc.walkAmount = 0;
    npc.sitAmount = 0;
    // A random START offset is not enough on its own to stop villagers
    // looking synchronised. With everyone running the identical waveform, two
    // who happen to start near each other stay near each other forever, and
    // every villager's stretch lands inside the same window of each gesture
    // cycle. So each one also gets a `idleSeed`, which poseIdleCycle turns
    // into its own oscillator rates, amplitudes and gesture period — with
    // different frequencies they drift apart continuously and can only ever
    // align for an instant, never persistently.
    //
    // The offset is spread over minutes rather than one 2*PI cycle so gesture
    // timings start uniformly distributed instead of bunched in ~6 seconds.
    npc.idlePhase = Math.random() * 600;
    // The seed is STRATIFIED, not random. Drawing it randomly sounds fine and
    // is not: with six villagers, 200 out of 200 random draws put two of them
    // within a second of each other's stretch period, and 175 out of 200 put
    // two within half a second — which is a pair visibly stretching together.
    // Stepping by the golden ratio spreads seeds as evenly as possible for
    // any number of villagers, so the closest pair is as far apart as it can
    // be. It's also stable per villager, so each keeps their own manner
    // across reloads rather than being redrawn every session.
    npc.idleSeed = (npcIndex * 0.6180339887498949) % 1;
    npc.idleAmount = 0;
    // Overwritten with the real values from the POI they're sitting at the
    // moment they arrive (see updateNpcMovement) — these defaults just make
    // sure a villager who's never sat down yet doesn't read `undefined`.
    npc.sitHeight = 0;
    npc.sitBend = NPC_SIT_BEND;
    npc.behavior = {
      mode: 'idle',
      timer: NPC_IDLE_MIN + Math.random() * (NPC_IDLE_MAX - NPC_IDLE_MIN),
      dest: null,
    };
  });

  layout.structures.forEach(({ s, model, center, rotated }) => {
    // Collider grows along with the visual scale so the player's bump
    // boundary still matches what they actually see, same as the model.
    // Not every structure has one — the Garden Patch is deliberately
    // walkable, so model.collide is null for it and nothing is added here.
    // (No `coastalOrientable` structure has a collider yet either, so this
    // doesn't need to account for a rotated hw/hh swap — revisit if one
    // ever does.)
    if (model.collide) {
      const collide = model.collide.type === 'circle'
        ? { type: 'circle', r: model.collide.r * STRUCTURE_MAP_SCALE }
        : { type: 'box', hw: model.collide.hw * STRUCTURE_MAP_SCALE, hh: model.collide.hh * STRUCTURE_MAP_SCALE };
      // structureId tags this collider so a villager walking toward this
      // exact structure to sit/observe (see updateNpcMovement's exclude
      // filter) can be excluded from it specifically — otherwise the
      // collider they're trying to reach would itself block them from
      // ever arriving.
      addCollider(center, collide, { structureId: s.id });
    }
    const group = model.build();
    group.scale.setScalar(STRUCTURE_MAP_SCALE);
    // Structures built long-axis-along-local-X (like the Beach) need a 90°
    // turn when they've auto-aligned to the east shore instead of the
    // south one — see resolveOrientedAnchor().
    group.rotation.y = rotated ? Math.PI / 2 : 0;
    group.position.set(center.x, 0, center.z);
    scene.add(group);
  });

  layout.trees.forEach(({ center }) => {
    colliders.push({ type: 'circle', x: center.x, z: center.z, r: TREE_RADIUS });
    makeGroveTree(scene, center.x, center.z, 0.65 + Math.random() * 0.2);
  });

  return { occupancy: layout.occupancy, colliders, npcs: layout.npcs, structures: layout.structures };
}

function smoothAngle(current, target, dt) {
  let diff = ((target - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return current + diff * Math.min(1, dt * 8);
}

const AVATAR_SPEED = 3.2;
const VILLAGE_MODEL_SCALE = 0.45;

// Camera-follow offset — lower and flatter than the original top-down-ish
// ~54°-from-horizontal angle (height 9.2 / back 6.7): height 5.0 / back 9.5
// works out to about 28° above the horizon, closer to the ground and much
// less overhead, per the user's explicit ask.
const VILLAGE_CAM_HEIGHT = 5.0;
const VILLAGE_CAM_BACK = 9.5;
const VILLAGE_CAM_LOOK_HEIGHT = 0.65;

// Placement-mode camera: pulled back to frame the whole board at once
// (centered on the board's own center, not following anything), rather than
// the tight follow-cam above, so the player can see every open cell while
// steering the ghost with the joystick. Same fixed tilt angle as the follow
// cam, just scaled up from the original pre-zoom whole-board framing
// (height 20 / back 14.5, tuned for the old 15-wide board) by GRID_SIZE so
// it still fits the whole board however big it is.
const VILLAGE_CAM_HEIGHT_OVERVIEW = 20 * (GRID_SIZE / 15);
const VILLAGE_CAM_BACK_OVERVIEW = 14.5 * (GRID_SIZE / 15);
const VILLAGE_CAM_LOOK_HEIGHT_OVERVIEW = 0.4;

// Physical collision radii — every object that can be stood next to has one
// of these, so the avatar's movement (see resolveVillageCollisions()) can't
// clip into any of them mid-stride, not just be blocked from *targeting*
// their cell. Buildings/structures use a box collider matching their grid
// footprint instead of a radius (set alongside the box's half-extents).
const AVATAR_RADIUS = 0.26;
const NPC_RADIUS = 0.28;
const TREE_RADIUS = 0.32;

// How close the avatar needs to walk to a villager before the "Talk" button
// appears — a little past NPC_RADIUS + AVATAR_RADIUS's actual touching
// distance, so the button shows up just before the player would visibly
// bump into them.
const TALK_RADIUS = 1.1;
// Same idea as TALK_RADIUS, but for the player's own "Sit" prompt — how
// close the avatar needs to be to an empty bench/beach-chair seat (see
// sitDown()) before the button offers it.
const SIT_RADIUS = 1.1;
// Same idea again, for the "Enter" prompt at the town hall's front doors —
// see getTownHallDoorPoint()/enterTownHall().
const ENTER_RADIUS = 1.1;

function getTownHallCenter() {
  const mid = Math.floor((GRID_SIZE - 3) / 2);
  return footprintCenterWorld(mid, mid, 3, 3);
}

// The town hall's own front-door threshold, in world space — just outside
// its collider's south edge (TOWN_HALL_COLLIDE), right where the double
// doors are actually modeled (see makeTownHall()).
function getTownHallDoorPoint() {
  const c = getTownHallCenter();
  return { x: c.x, z: c.z + TOWN_HALL_COLLIDE.hh };
}

// Ambient villager wandering (see updateNpcMovement/pickWanderDestination):
// deliberately slow — well under half the avatar's own AVATAR_SPEED — so it
// reads as a leisurely stroll, never a beeline toward the player.
const NPC_WALK_SPEED = 0.6;
// How long a villager stands idle at home before considering a wander, and
// how long it lingers at a destination (sitting/observing/just looking
// around) before heading back — both randomized per-trip so villagers don't
// all move in lockstep. Deliberately long (~5 minutes, give or take) so a
// villager reads as genuinely settled in one place or the other, not
// restlessly shuffling around — per the user's explicit ask, don't shrink
// these back down without them asking again (see the "villagers standing
// outside their house is fine" feedback note).
const NPC_IDLE_MIN = 240, NPC_IDLE_MAX = 360;
const NPC_INTERACT_MIN = 240, NPC_INTERACT_MAX = 360;
// World-space height of a bench's seat (local y 0.34 in makeBench(),
// carried through the same STRUCTURE_MAP_SCALE placed structures render
// at) — a sitting villager's root is lerped up to this by their own
// sitAmount, see poseSitCycle() and animate()'s per-npc loop. NPC_SIT_BEND
// is the matching default leg-bend angle for a normal seat.
const NPC_SIT_HEIGHT = 0.34 * STRUCTURE_MAP_SCALE;

// A seat's `sitHeight` is the height of the seat SURFACE. What gets moved is
// the character's root, which sits at their feet — so raising the root to the
// seat height puts their feet on the bench and leaves the body hovering above
// it. The gap is exactly how far the seated body's underside sits above its
// own root, which is measured off the real rig here rather than guessed:
// build a character, pose it with poseSitCycle, and read the lowest point of
// everything that isn't a leg. Measured rather than hardcoded so it stays
// correct if the character's proportions are ever retuned again.
let seatedDropCache = null;
function seatedBodyDrop() {
  if (seatedDropCache !== null) return seatedDropCache;
  if (typeof THREE === 'undefined') return 0;
  const probe = new THREE.Group();
  const model = new THREE.Group();
  const ch = buildCharacter(state.character);
  model.add(ch);
  model.scale.setScalar(VILLAGE_MODEL_SCALE);
  model.position.y = -(GROUND_Y + FOOT_MARGIN) * VILLAGE_MODEL_SCALE;
  probe.add(model);
  poseSitCycle(ch, 1, NPC_SIT_BEND);
  probe.updateMatrixWorld(true);
  const limbs = ch.userData.limbs;
  let lowest = Infinity;
  ch.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) if (p === limbs.leftLeg || p === limbs.rightLeg) return;
    lowest = Math.min(lowest, new THREE.Box3().setFromObject(o).min.y);
  });
  seatedDropCache = Number.isFinite(lowest) ? lowest : 0;
  return seatedDropCache;
}

// How far to step clear of a seat on standing up. A sit POI is the seat's own
// centre, so without this the player is left standing inside the bench —
// collisions only resolve while moving, so nothing ever pushes them out.
const SEAT_EXIT_STEP = 0.6;
const NPC_SIT_BEND = -1.35;

// A beach lounger sits lower and reclines further back than a bench — its
// own seat height (local y 0.19 in makeBeach()'s makeLounger(), and it must
// stay in step with the pad there) and a deeper leg bend, both used only
// while a villager is seated at one of the two chair spots in
// BEACH_LOUNGER_SPOTS below.
// The 0.02 is makeBeach()'s SAND_Y — both lounger scenes are parented to a
// group sitting on the sand plane, so the pad's real height is its own local
// y PLUS that lift. Leaving it out (as this did originally, with the old 0.09
// pad) put the seat 0.026 below the cushion it was meant to describe.
const BEACH_SIT_HEIGHT = (0.19 + 0.02) * STRUCTURE_MAP_SCALE;
const BEACH_SIT_BEND = -1.5;

// The two beach loungers' own local position/rotation, copied straight from
// makeBeach()'s scene1/scene2 groups — this is how buildInteractionPOIs()
// knows exactly where a villager should sit down relative to the beach's
// placed center (see rotateLocalToWorld, which carries a possibly-rotated
// beach's local offsets into world space the same way placeVillageWorld
// itself positions the beach model).
const BEACH_LOUNGER_SPOTS = [
  { x: -1.1, z: 0.3, facing: 0.35 },
  { x: 1.15, z: -0.35, facing: -0.5 },
];

// Rotates a local (x,z) offset by `angle` radians around Y — the same
// rotation placeVillageWorld() applies to a coastal structure's whole model
// (0 normally, Math.PI/2 once auto-oriented onto the east shore, see
// resolveOrientedAnchor) — so a POI tied to a specific point on that model
// (a beach lounger) lands in the right spot in world space regardless of
// which shore it ended up on.
function rotateLocalToWorld(lx, lz, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: lx * cos + lz * sin, z: -lx * sin + lz * cos };
}

let villageScene = null, villageCamera = null, villageRenderer = null;
let villageAnimId = null, villageClock = null;
let villageAvatarRoot = null, villageOccupancy = null, villageColliders = null;
let villageJoystickBase = null, villageJoystickHandlers = null;
let villagePlacementGhost = null, villagePlacementCursor = null;
let villageNpcs = [], nearbyTalkNpc = null, activeDialogue = null;
let nearbyPlayerHouseDoor = false;
// Points of interest a wandering villager can walk to and interact with —
// one per placed structure that supports it (a bench to sit on, everything
// else with a build to stand and look at) — rebuilt fresh each scene init
// from the real placed structures, see buildInteractionPOIs().
let villagePOIs = [];
// The player's own sit-down state: `avatarSitting` is the exact 'sit' POI
// (see buildInteractionPOIs) the avatar is currently parked at, or null;
// `avatarSitTarget` is set in between — from the moment "Sit" is tapped
// until the avatar actually walks over and arrives — see the auto-walk
// block in animate(). `nearbySeat` is whichever empty seat (if any) is
// close enough right now for the Sit button to offer — see the SIT_RADIUS
// check in animate() and sitDown()/standUp()/toggleSit() below.
let avatarSitting = null, avatarSitTarget = null, nearbySeat = null;
// Whether the avatar is currently close enough to the town hall's front
// doors for the "Enter" button to offer — see ENTER_RADIUS/enterTownHall().
let nearbyTownHallDoor = false;
// The same, for the party hall — which unlike the town hall is a
// purchasable structure, so it may not be in the town at all yet.
let nearbyPartyHallDoor = false;

function teardownVillageScene() {
  // Remember exactly where the avatar was standing (continuous, not
  // grid-snapped) so the next time the Village screen inits — whether
  // that's a real nav-away-and-back or one of the internal re-inits this
  // function itself triggers via initVillageScene() (e.g. confirming or
  // cancelling a structure placement) — getVillageSpawnPoint() can put the
  // avatar right back there instead of the fixed default spawn tile.
  if (villageAvatarRoot) {
    state.villagePos = { x: villageAvatarRoot.position.x, z: villageAvatarRoot.position.z };
    saveState();
  }
  if (villageAnimId !== null) cancelAnimationFrame(villageAnimId);
  villageAnimId = null;
  if (villageRenderer) {
    villageRenderer.dispose();
    if (villageRenderer.forceContextLoss) villageRenderer.forceContextLoss();
    villageRenderer = null;
  }
  if (villageJoystickBase && villageJoystickHandlers) {
    villageJoystickBase.removeEventListener('pointerdown', villageJoystickHandlers.down);
    villageJoystickBase.removeEventListener('pointermove', villageJoystickHandlers.move);
    villageJoystickBase.removeEventListener('pointerup', villageJoystickHandlers.up);
    villageJoystickBase.removeEventListener('pointercancel', villageJoystickHandlers.up);
    villageJoystickBase.removeEventListener('lostpointercapture', villageJoystickHandlers.up);
    window.removeEventListener('pointerup', villageJoystickHandlers.up);
    window.removeEventListener('pointercancel', villageJoystickHandlers.up);
    window.removeEventListener('blur', villageJoystickHandlers.reset);
  }
  villageJoystickBase = null;
  villageJoystickHandlers = null;
  villagePlacementGhost = null;
  villagePlacementCursor = null;
  villageScene = null;
  villageCamera = null;
  villageAvatarRoot = null;
  villageOccupancy = null;
  villageColliders = null;
  villageNav = null;
  villageNpcs = [];
  villagePOIs = [];
  nearbyTalkNpc = null;
  activeDialogue = null;
  avatarSitting = null;
  avatarSitTarget = null;
  nearbySeat = null;
  nearbyTownHallDoor = false;
  nearbyPartyHallDoor = false;
}

// Builds the semi-transparent preview model + a colored footprint tile
// shown during placement mode (see initVillageScene) — real model materials
// cloned down in opacity rather than a flat-tinted blob, so it still reads
// as the actual structure, plus a green/red ground tile under it that's the
// clearer valid/invalid signal at a glance.
function buildPlacementGhost(model) {
  const group = model.build();
  group.scale.setScalar(STRUCTURE_MAP_SCALE);
  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = false;
      obj.material = obj.material.clone();
      obj.material.transparent = true;
      obj.material.opacity = 0.6;
      obj.material.depthWrite = false;
    }
  });
  const footprintMat = new THREE.MeshBasicMaterial({ color: 0x4CAF6D, transparent: true, opacity: 0.45, depthWrite: false });
  const footprint = new THREE.Mesh(
    new THREE.PlaneGeometry(model.w * CELL - 0.05, model.h * CELL - 0.05),
    footprintMat
  );
  footprint.rotation.x = -Math.PI / 2;
  footprint.position.y = 0.02;
  const wrapper = new THREE.Group();
  wrapper.add(footprint);
  wrapper.add(group);
  return { wrapper, footprintMat };
}

// Pushes `pos` back out of any collider it's overlapping, given the moving
// object's own radius — circle-vs-circle for NPCs/trees, circle-vs-box for
// building footprints. Called every frame the avatar moves, so it can't
// clip through anything mid-stride even though the grid's occupancy check
// (see the pointerdown handler) already keeps it from ever *targeting* an
// occupied cell in the first place.
// `exclude(collider) => bool` is optional — used by wandering villagers
// (see updateNpcMovement) to skip their own collider (so they don't push
// against themselves) and, while walking up to their own destination
// structure, that structure's collider too (otherwise the very thing
// they're trying to reach — a bench to sit on, say — would itself block
// them from ever arriving). The avatar's own movement never passes one.
// The player is NOT in villageColliders — that list is built once from the
// placed structures and the villagers' home spots, and the avatar moves every
// frame — so a villager resolving against it alone will walk straight through
// the player. The avatar collides with villagers already (their circles are
// updated every frame in animate()); this is the other half of that, so the
// two actually block each other instead of only one noticing. Same
// circle-vs-circle push resolveVillageCollisions uses, and the villager is
// the one that yields: the player never gets shoved around by an NPC.
// ---------- Villager pathfinding ----------
//
// Straight-line steering plus collision push-out cannot get around a
// building. Aimed square at a wall the push has no sideways component to
// slide along, so a villager either presses into it until walkTimeout gives
// up, or wedges permanently in a pinch point between two colliders. Measured
// before this existed, walking from their own front doors, villagers reached
// the fountain 0 times out of 6 and the sports court 0 out of 6.
//
// So a walk now follows a real route: A* over a grid sampled from the SAME
// collider list the movement code resolves against, so the planner's idea of
// what is walkable and what actually stops a villager cannot drift apart.
// The push-out stays exactly as it was underneath — it still handles the
// things a static grid can't know about (other villagers, the player), and
// it remains the final authority on overlap.
const NAV_CELL = 0.25;
const NAV_MARGIN = 0.02;      // keeps a route off the very skin of a wall
const NAV_WAYPOINT_HIT = 0.3; // how close counts as reaching a waypoint
const NAV_SEARCH_RING = 10;   // cells to search outward for a free start/goal
let villageNav = null;

function navPointBlocked(x, z, statics) {
  for (let k = 0; k < statics.length; k++) {
    const c = statics[k];
    if (c.type === 'circle') {
      if (Math.hypot(x - c.x, z - c.z) < c.r + NPC_RADIUS + NAV_MARGIN) return true;
    } else {
      const cx = Math.max(c.x - c.hw, Math.min(x, c.x + c.hw));
      const cz = Math.max(c.z - c.hh, Math.min(z, c.z + c.hh));
      if (Math.hypot(x - cx, z - cz) < NPC_RADIUS + NAV_MARGIN) return true;
    }
  }
  return false;
}

// Only STATIC colliders go into the grid. Anything tagged npcId is a
// villager, whose circle is moved every frame to wherever they now are, and
// the player is never in the list at all. Baking either into the grid would
// leave a permanent phantom wall wherever they happened to be standing when
// the village loaded.
function buildVillageNav(colliders) {
  const span = GRID_SIZE * CELL;
  const n = Math.ceil(span / NAV_CELL);
  const origin = -span / 2;
  const statics = (colliders || []).filter((c) => !c.npcId);
  const blocked = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = origin + (i + 0.5) * NAV_CELL;
      const z = origin + (j + 0.5) * NAV_CELL;
      if (navPointBlocked(x, z, statics)) blocked[j * n + i] = 1;
    }
  }
  return { n, origin, blocked };
}

function navCellAt(nav, x, z) {
  const i = Math.floor((x - nav.origin) / NAV_CELL);
  const j = Math.floor((z - nav.origin) / NAV_CELL);
  return { i: Math.max(0, Math.min(nav.n - 1, i)), j: Math.max(0, Math.min(nav.n - 1, j)) };
}

function navCellCenter(nav, i, j) {
  return { x: nav.origin + (i + 0.5) * NAV_CELL, z: nav.origin + (j + 0.5) * NAV_CELL };
}

// A sit POI is inside its own structure's footprint by design, and a villager
// nudged half inside something is normal mid-push. Both would otherwise make
// the search fail outright, so start and goal both snap to the nearest cell
// that is actually free.
function navNearestFree(nav, i, j) {
  if (!nav.blocked[j * nav.n + i]) return { i, j };
  for (let r = 1; r <= NAV_SEARCH_RING; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nav.n || nj >= nav.n) continue;
        if (!nav.blocked[nj * nav.n + ni]) return { i: ni, j: nj };
      }
    }
  }
  return null;
}

// Binary min-heap. A linear scan of the open set would also work on a grid
// this size, but worst case it is millions of comparisons for a single walk,
// and villagers re-plan often enough with the dev Walk toggle on to turn
// that into a visible hitch.
function navHeapPush(heap, score, idx, f) {
  heap.push(idx);
  let c = heap.length - 1;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (f[heap[p]] <= f[heap[c]]) break;
    const t = heap[p]; heap[p] = heap[c]; heap[c] = t;
    c = p;
  }
}

function navHeapPop(heap, f) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let p = 0;
    for (;;) {
      const l = p * 2 + 1, r = l + 1;
      let m = p;
      if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
      if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
      if (m === p) break;
      const t = heap[m]; heap[m] = heap[p]; heap[p] = t;
      p = m;
    }
  }
  return top;
}

const NAV_NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function navFindPath(nav, from, to) {
  if (!nav) return null;
  const a = navCellAt(nav, from.x, from.z);
  const b = navCellAt(nav, to.x, to.z);
  const start = navNearestFree(nav, a.i, a.j);
  const goal = navNearestFree(nav, b.i, b.j);
  if (!start || !goal) return null;
  const n = nav.n, total = n * n;
  const startIdx = start.j * n + start.i, goalIdx = goal.j * n + goal.i;
  if (startIdx === goalIdx) return [];

  const g = new Float32Array(total).fill(Infinity);
  const f = new Float32Array(total).fill(Infinity);
  const cameFrom = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  // Octile distance — admissible for 8-way movement, so the route is optimal.
  const heuristic = (i, j) => {
    const di = Math.abs(i - goal.i), dj = Math.abs(j - goal.j);
    return (Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj)) * NAV_CELL;
  };
  g[startIdx] = 0;
  f[startIdx] = heuristic(start.i, start.j);
  const heap = [];
  navHeapPush(heap, f[startIdx], startIdx, f);

  // Closest cell actually reached, so a goal that turns out to be unreachable
  // still yields a route to the nearest point that IS. This matters more than
  // it sounds: snapping a blocked goal to its nearest free cell can land in a
  // sealed pocket — the gap behind a bench, say — and 16 of this town's 4332
  // free cells are pockets like that. Without this the search returns nothing
  // and the villager falls straight back to walking into walls.
  let bestIdx = startIdx, bestH = heuristic(start.i, start.j);
  let reachedGoal = false;

  while (heap.length) {
    const cur = navHeapPop(heap, f);
    if (cur === goalIdx) { reachedGoal = true; break; }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % n, cj = (cur - ci) / n;
    const curH = heuristic(ci, cj);
    if (curH < bestH) { bestH = curH; bestIdx = cur; }
    for (let k = 0; k < NAV_NEIGHBOURS.length; k++) {
      const [di, dj, cost] = NAV_NEIGHBOURS[k];
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nIdx = nj * n + ni;
      if (nav.blocked[nIdx] || closed[nIdx]) continue;
      // No cutting a diagonal past the corner of something solid — that is
      // a route the push-out would refuse to actually let them walk.
      if (di !== 0 && dj !== 0) {
        if (nav.blocked[cj * n + ni] || nav.blocked[nj * n + ci]) continue;
      }
      const tentative = g[cur] + cost * NAV_CELL;
      if (tentative < g[nIdx]) {
        cameFrom[nIdx] = cur;
        g[nIdx] = tentative;
        f[nIdx] = tentative + heuristic(ni, nj);
        navHeapPush(heap, f[nIdx], nIdx, f);
      }
    }
  }
  const endIdx = reachedGoal ? goalIdx : bestIdx;
  if (endIdx === startIdx) return null;

  const cells = [];
  for (let idx = endIdx; idx !== -1 && idx !== startIdx; idx = cameFrom[idx]) {
    const i = idx % n, j = (idx - i) / n;
    cells.push(navCellCenter(nav, i, j));
  }
  cells.reverse();
  return navSmooth(nav, from, cells);
}

function navClearLine(nav, a, b) {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(dist / (NAV_CELL * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cell = navCellAt(nav, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (nav.blocked[cell.j * nav.n + cell.i]) return false;
  }
  return true;
}

// String-pulling. Raw A* output steps cell to cell, which walks as a visible
// staircase; this keeps only the corners that a straight line can't cut.
function navSmooth(nav, from, cells) {
  if (!cells.length) return cells;
  const pts = [from].concat(cells);
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !navClearLine(nav, pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

function resolveAvatarCollision(pos, radius) {
  if (!villageAvatarRoot) return pos;
  const dx = pos.x - villageAvatarRoot.position.x;
  const dz = pos.z - villageAvatarRoot.position.z;
  const minDist = radius + AVATAR_RADIUS;
  const d = Math.hypot(dx, dz);
  if (d < minDist && d > 0.0001) {
    const push = minDist - d;
    pos.x += (dx / d) * push;
    pos.z += (dz / d) * push;
  }
  return pos;
}

function resolveVillageCollisions(pos, radius, exclude) {
  villageColliders.forEach((c) => {
    if (exclude && exclude(c)) return;
    if (c.type === 'circle') {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const minDist = c.r + radius;
      const d = Math.hypot(dx, dz);
      if (d < minDist && d > 0.0001) {
        const push = minDist - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      }
    } else {
      const closestX = Math.max(c.x - c.hw, Math.min(pos.x, c.x + c.hw));
      const closestZ = Math.max(c.z - c.hh, Math.min(pos.z, c.z + c.hh));
      const dx = pos.x - closestX, dz = pos.z - closestZ;
      const d = Math.hypot(dx, dz);
      if (d < radius && d > 0.0001) {
        const push = radius - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      }
    }
  });
  return pos;
}

// One or more POIs per placed structure that a wandering villager can walk
// to and interact with, each tagged with a stable `poiId` (unique even for
// a structure with more than one spot) and `type` (the structure's own id,
// e.g. 'bench'/'beach' — used by pickWanderDestination to bias a
// structure-triggered villager toward their own origin structure, and by
// repeatVisitLine() to pick the right flavor of dialogue):
// - A bench gets one 'sit' spot at its own center, facing the same local
//   +z its seat is built to face (see makeBench()).
// - A beach gets two 'sit' spots, one per lounger chair — copied from
//   makeBeach()'s own scene1/scene2 local positions via BEACH_LOUNGER_SPOTS
//   and carried into world space with rotateLocalToWorld() so this still
//   lines up correctly if the beach auto-oriented onto the east shore.
// - Everything else gets an 'observe' spot a little outside its own
//   footprint, facing back toward it, so a villager reads as genuinely
//   standing there admiring it rather than just passing through. No other
//   coastal-restricted structure exists today, but the same reasoning as
//   the beach would apply if one ever did — a fixed "stand just past the
//   edge" point could land in the water.
function buildInteractionPOIs(structures) {
  const pois = [];
  (structures || []).forEach(({ s, model, center, rotated }) => {
    if (s.type === 'bench') {
      pois.push({
        poiId: s.id, structureId: s.id, type: s.type, kind: 'sit',
        pos: { x: center.x, z: center.z }, facing: 0,
        sitHeight: NPC_SIT_HEIGHT, sitBend: NPC_SIT_BEND,
      });
      return;
    }
    if (s.type === 'beach') {
      const angle = rotated ? Math.PI / 2 : 0;
      BEACH_LOUNGER_SPOTS.forEach((spot, i) => {
        const off = rotateLocalToWorld(spot.x * STRUCTURE_MAP_SCALE, spot.z * STRUCTURE_MAP_SCALE, angle);
        pois.push({
          poiId: `${s.id}:${i}`, structureId: s.id, type: s.type, kind: 'sit',
          pos: { x: center.x + off.x, z: center.z + off.z }, facing: spot.facing + angle,
          sitHeight: BEACH_SIT_HEIGHT, sitBend: BEACH_SIT_BEND,
        });
      });
      return;
    }
    if (model.coastalOnly) return;
    const half = model.collide
      ? (model.collide.type === 'circle' ? model.collide.r : model.collide.hh) * STRUCTURE_MAP_SCALE
      : (model.h / 2) * STRUCTURE_MAP_SCALE;
    const pos = { x: center.x, z: center.z + half + 0.45 };
    const facing = Math.atan2(center.x - pos.x, center.z - pos.z);
    pois.push({ poiId: s.id, structureId: s.id, type: s.type, kind: 'observe', pos, facing });
  });
  return pois;
}

// Every POI currently spoken for — by a villager already walking to or
// interacting with it (`excludeNpc`, if given, skips that one villager's
// own claim, so an npc deciding where to go next doesn't get blocked by
// the destination it hasn't left yet), and by the player themselves if
// they're sitting somewhere (see sitDown()). Shared by pickWanderDestination
// (so villagers don't double up) and animate()'s own seat search for the
// "Sit" button (so the player is never offered a seat someone's using).
function claimedPoiIds(excludeNpc) {
  const claimed = new Set();
  villageNpcs.forEach((other) => {
    if (other === excludeNpc || !other.behavior) return;
    const m = other.behavior.mode;
    const dest = other.behavior.dest;
    if ((m === 'walking' || m === 'interacting') && dest && dest.poiId) claimed.add(dest.poiId);
  });
  // Both halves of the player's sit state count as a claim. Only
  // avatarSitting used to, which left the seat looking free during the
  // ~0.3s walk-over (SIT_RADIUS 1.1 at AVATAR_SPEED 3.2) — a villager whose
  // idle timer expired in that window could target the very seat being
  // walked to, and both would arrive at it.
  if (avatarSitting) claimed.add(avatarSitting.poiId);
  if (avatarSitTarget) claimed.add(avatarSitTarget.poiId);
  return claimed;
}

// Chooses where a villager standing idle at home should wander to next —
// favors an available POI (see buildInteractionPOIs) so structures actually
// get visited, but falls back to a short aimless stroll to a nearby open
// cell so there's still some ambient movement in a town with nothing built
// yet. Returns null (stay put a while longer) if nothing usable is found.
//
// A structure-triggered villager (npc.structureId set to the archetype
// that drew them in, e.g. 'beach' for the surfer) is heavily biased toward
// POIs on that exact structure type — they should primarily be found at
// the thing that brought them to town — while still occasionally visiting
// elsewhere, and every other villager (including the 2 fixed neighbors, who
// have no origin structure at all) treats every POI as equally fair game.
function pickWanderDestination(npc) {
  const claimed = claimedPoiIds(npc);
  const available = villagePOIs.filter((poi) => !claimed.has(poi.poiId));
  if (available.length && Math.random() < 0.7) {
    const home = npc.structureId ? available.filter((poi) => poi.type === npc.structureId) : [];
    const pool = (home.length && Math.random() < 0.8) ? home : available;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  for (let i = 0; i < 6; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 1.5 + Math.random() * 2.5;
    const x = npc.center.x + Math.cos(ang) * dist;
    const z = npc.center.z + Math.sin(ang) * dist;
    if (Math.abs(x) > GRID_HALF - 0.6 || Math.abs(z) > GRID_HALF - 0.6) continue;
    const cell = worldToGridCell(x, z);
    if (villageOccupancy && villageOccupancy[cell.row] && !villageOccupancy[cell.row][cell.col]) {
      return { poiId: null, structureId: null, type: null, kind: 'wander', pos: { x, z }, facing: Math.random() * Math.PI * 2 };
    }
  }
  return null;
}

// Puts a villager into 'walking' mode toward `dest`, and sizes up a
// generous stuck-timeout for this specific leg from the straight-line
// distance involved — 2.5x the time a completely clear walk would take,
// plus a flat 5s cushion, comfortably covers a normal wall-slide around a
// corner (see resolveVillageCollisions) without falsely tripping, while
// still catching a villager truly wedged in place. See the 'walking'
// branch of updateNpcMovement for what happens when it does trip.
function beginWalking(npc, dest) {
  npc.behavior.dest = dest;
  npc.behavior.mode = 'walking';
  npc.behavior.walkElapsed = 0;
  // Plan the route now. The final leg is always steered straight at the
  // exact destination: a sit POI is inside its own structure's collider, so
  // it is a blocked nav cell by definition, and getting onto it is precisely
  // what the sit exemption below is for.
  const path = navFindPath(villageNav, npc.pos, dest.pos);
  npc.behavior.path = path && path.length ? path : null;
  npc.behavior.pathIndex = 0;
  // The timeout has to be measured along the ROUTE, not the straight line.
  // A legitimate walk around the far side of a building is longer than the
  // crow flies, and sizing the allowance on the straight line would cut it
  // off as a stall exactly when the pathfinding was doing its job.
  let dist0 = 0;
  let prev = npc.pos;
  (npc.behavior.path || []).forEach((p) => {
    dist0 += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  });
  dist0 += Math.hypot(dest.pos.x - prev.x, dest.pos.z - prev.z);
  npc.behavior.walkTimeout = (dist0 / NPC_WALK_SPEED) * 2.5 + 5;
}

// Advances one villager's own little idle → walk → interact → walk home →
// idle loop by `dt`. Deliberately not run at all for whichever villager the
// player is currently mid-conversation with (see animate()'s per-npc loop)
// so a dialogue partner always stays put — same reasoning as the avatar's
// own movement freezing during a conversation.
function updateNpcMovement(npc, dt) {
  const b = npc.behavior;
  if (b.mode === 'idle') {
    b.timer -= dt;
    if (b.timer <= 0) {
      const dest = pickWanderDestination(npc);
      if (dest) {
        beginWalking(npc, dest);
      } else {
        b.timer = NPC_IDLE_MIN + Math.random() * (NPC_IDLE_MAX - NPC_IDLE_MIN);
      }
    }
  } else if (b.mode === 'walking') {
    const pos = npc.pos;
    const dx = b.dest.pos.x - pos.x, dz = b.dest.pos.z - pos.z;
    const dist = Math.hypot(dx, dz);
    b.walkElapsed += dt;
    if (dist < 0.05) {
      pos.x = b.dest.pos.x;
      pos.z = b.dest.pos.z;
      npc.facingAngle = b.dest.facing;
      if (b.dest.kind === 'home') {
        b.mode = 'idle';
        b.timer = NPC_IDLE_MIN + Math.random() * (NPC_IDLE_MAX - NPC_IDLE_MIN);
        b.dest = null;
      } else {
        b.mode = 'interacting';
        b.timer = NPC_INTERACT_MIN + Math.random() * (NPC_INTERACT_MAX - NPC_INTERACT_MIN);
        // Stashed on the npc itself (not read from b.dest each frame in
        // animate()) because b.dest gets replaced with a plain 'home'
        // destination the instant this interaction ends — reading
        // sitHeight/sitBend from a dest that might already be the
        // (heightless) walk-home one would sit-height a villager mid-
        // stride back to their house.
        if (b.dest.kind === 'sit') {
          npc.sitHeight = b.dest.sitHeight;
          npc.sitBend = b.dest.sitBend;
        }
      }
    } else if (b.walkElapsed > b.walkTimeout) {
      // resolveVillageCollisions' push-out approximates a wall-slide well
      // enough for most angled approaches (verified: a villager walking at
      // an angle past a house-sized obstacle reaches the far side in
      // ~11s), but a path aimed dead-on at the center of a wall has no
      // sideways push to slide along at all — verified live too: stalled
      // permanently, frozen right at the wall's edge, no matter how long
      // it waited. Rather than build real pathfinding for what should be a
      // rare exact-alignment case, just give up on this leg and go home —
      // an occasional villager popping back home beats one stuck walking
      // in place forever.
      npc.pos.x = npc.center.x;
      npc.pos.z = npc.center.z;
      npc.facingAngle = npc.facing;
      b.mode = 'idle';
      b.timer = NPC_IDLE_MIN + Math.random() * (NPC_IDLE_MAX - NPC_IDLE_MIN);
      b.dest = null;
    } else {
      // Steer at the next waypoint rather than straight at the destination.
      // `dist` above still measures the real destination, so arrival and the
      // timeout are unaffected — running off the end of the path just hands
      // over to a straight final approach.
      let aimX = b.dest.pos.x, aimZ = b.dest.pos.z;
      if (b.path) {
        while (b.pathIndex < b.path.length &&
               Math.hypot(b.path[b.pathIndex].x - pos.x, b.path[b.pathIndex].z - pos.z) < NAV_WAYPOINT_HIT) {
          b.pathIndex++;
        }
        if (b.pathIndex < b.path.length) {
          aimX = b.path[b.pathIndex].x;
          aimZ = b.path[b.pathIndex].z;
        }
      }
      const adx = aimX - pos.x, adz = aimZ - pos.z;
      const adist = Math.hypot(adx, adz) || 1;
      const step = Math.min(dist, NPC_WALK_SPEED * dt);
      const dirX = adx / adist, dirZ = adz / adist;
      pos.x += dirX * step;
      pos.z += dirZ * step;
      // Only a SIT destination may ignore its own structure's collider.
      // A sit POI is inside the footprint by construction (the bench's is
      // its dead centre), so without the exemption a villager could never
      // reach the seat. An 'observe' POI is the opposite case: it is placed
      // at half + 0.45 — a clear 0.45 beyond the collider's own edge, more
      // than NPC_RADIUS — so it never needed the exemption, and granting it
      // anyway switched that structure OFF for the entire journey. That is
      // what let a villager walk clean through the Party Hall on the way to
      // standing in front of it.
      const excludeId = b.dest.kind === 'sit' ? b.dest.structureId : null;
      resolveVillageCollisions(pos, NPC_RADIUS, (c) => c.npcId === npc.id || (!!excludeId && c.structureId === excludeId));
      resolveAvatarCollision(pos, NPC_RADIUS);
      npc.facingAngle = smoothAngle(npc.facingAngle, Math.atan2(dirX, dirZ), dt);
    }
  } else if (b.mode === 'interacting') {
    b.timer -= dt;
    if (b.timer <= 0) {
      beginWalking(npc, { poiId: null, structureId: null, type: null, kind: 'home', pos: { x: npc.center.x, z: npc.center.z }, facing: npc.facing });
    }
  }
}

function initVillageScene() {
  teardownVillageScene();
  const holder = document.getElementById('villageScene');
  if (!holder || typeof THREE === 'undefined') return;

  villageScene = new THREE.Scene();
  // A background Color fill bypasses the renderer's tone mapping/exposure
  // (only materials go through that), so it's hand-tuned here to track the
  // same brightness level as everything else instead of drifting out of
  // sync with it.
  villageScene.background = new THREE.Color(0xA2C4D5);
  // The forest and water run out to BORDER_FAR (140 units) so their real
  // edge is never reachable in view, but that's still a finite plane —
  // fog is what actually sells "goes on forever," fading everything past
  // the town into the sky color well before anyone could see it stop.
  villageScene.fog = new THREE.Fog(0xA2C4D5, 24, 58);

  // Zoomed-in top-down camera that follows the avatar — same fixed tilt
  // angle as before (it never rotates, so the joystick's screen-right =
  // world +X / screen-down = world +Z mapping still holds), just closer in
  // and re-centered on the player every frame instead of sitting still over
  // the whole board. Position/lookAt get set for real once the avatar's
  // spawn point is known, below.
  villageCamera = new THREE.PerspectiveCamera(50, holder.clientWidth / holder.clientHeight, 0.1, 220);

  villageRenderer = new THREE.WebGLRenderer({ antialias: true });
  villageRenderer.setSize(holder.clientWidth, holder.clientHeight);
  villageRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  villageRenderer.shadowMap.enabled = true;
  villageRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Exposure is a global brightness dial (scales every rendered color up or
  // down evenly, hue/saturation untouched) rather than hand-editing every
  // material color across every model builder. Toned down from full
  // brightness after the scene read as "super bright," then brought back up
  // partway — lit up more, but still landing well short of the original
  // blown-out level, so the same toned-down palette just reads brighter/
  // better-lit rather than washed out again.
  villageRenderer.toneMapping = THREE.LinearToneMapping;
  villageRenderer.toneMappingExposure = 0.85;
  holder.appendChild(villageRenderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x4CAF6D, 0.78);
  villageScene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d0, 0.95);
  sun.position.set(6, 12, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  villageScene.add(sun);

  // A huge grass pad under everything — the board, the forest, and the
  // water all sit on top of it. The forest/water only cover the north+west
  // and south+east bands, so this is what shows through the two open
  // diagonal corners (northeast, southwest) instead of a void — and being
  // this large (not just a few units past the border) is what keeps the
  // square plot from ever showing a visible edge there either, same as the
  // forest/water rely on fog for their own edges.
  const backdrop = new THREE.Mesh(
    new THREE.BoxGeometry(400, 0.3, 400),
    new THREE.MeshStandardMaterial({ color: 0x6FCB6F, roughness: 0.95 })
  );
  backdrop.position.y = -0.22;
  backdrop.receiveShadow = true;
  villageScene.add(backdrop);

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_SIZE * CELL, GRID_SIZE * CELL),
    new THREE.MeshStandardMaterial({ map: makeGroundGridTexture(), roughness: 0.95 })
  );
  board.rotation.x = -Math.PI / 2;
  board.position.y = 0;
  board.receiveShadow = true;
  villageScene.add(board);

  buildForestWall(villageScene);
  buildWaterBorder(villageScene);

  const spawnPoint = getVillageSpawnPoint();
  const spawnCol = spawnPoint.col, spawnRow = spawnPoint.row;
  const placed = placeVillageWorld(villageScene, spawnCol, spawnRow);
  villageOccupancy = placed.occupancy;
  villageColliders = placed.colliders;
  // Sampled from the colliders that were just built, so the route grid and
  // the collision that actually stops a villager always come from one source.
  villageNav = buildVillageNav(villageColliders);
  villageNpcs = placed.npcs;
  villagePOIs = buildInteractionPOIs(placed.structures);

  // Placement mode: a semi-transparent ghost of the structure being placed,
  // driven by the same joystick that walks the avatar (see the joystick
  // wiring below and its use in animate()) — villagePlacementCursor is a
  // continuous world x/z position that the joystick pushes around exactly
  // like the avatar, snapped each frame to the nearest grid-aligned
  // footprint so the ghost always sits on real cells. Nothing here runs at
  // all when state.placement is null, so a normal village visit pays zero
  // extra cost for this.
  function updatePlacementGhost() {
    if (!villagePlacementGhost || !state.placement) return;
    const model = STRUCTURE_MODELS[state.placement.structureId];
    const { col, row } = state.placement;
    const rotated = !!state.placement.rotated;
    const valid = isPlacementValid(model, villageOccupancy, col, row, rotated);
    const w = rotated ? model.h : model.w;
    const h = rotated ? model.w : model.h;
    const center = footprintCenterWorld(col, row, w, h);
    villagePlacementGhost.wrapper.position.set(center.x, 0, center.z);
    // The footprint tile and model inside the wrapper are both built once,
    // at the model's natural w/h — rotating the whole wrapper 90° reorients
    // them together exactly the same way a real placed-and-rotated
    // structure would look (see placeVillageWorld()), no separate rebuild.
    villagePlacementGhost.wrapper.rotation.y = rotated ? Math.PI / 2 : 0;
    villagePlacementGhost.footprintMat.color.set(valid ? 0x4CAF6D : 0xE0524A);
    state.placement.valid = valid;
    const confirmBtn = document.getElementById('placementConfirmBtn');
    if (confirmBtn) confirmBtn.disabled = !valid;
  }

  // Moves villagePlacementCursor by a joystick step and re-derives the
  // footprint's grid anchor from it — the cursor is treated as the
  // footprint's *center*, not its top-left corner, so it tracks roughly
  // where the player steered regardless of the structure's width/height
  // (odd or even).
  function movePlacementCursor(dirX, dirZ, step) {
    const model = STRUCTURE_MODELS[state.placement.structureId];
    villagePlacementCursor.x = Math.max(-GRID_HALF, Math.min(GRID_HALF, villagePlacementCursor.x + dirX * step));
    villagePlacementCursor.z = Math.max(-GRID_HALF, Math.min(GRID_HALF, villagePlacementCursor.z + dirZ * step));
    const gx = villagePlacementCursor.x / CELL + (GRID_SIZE - 1) / 2;
    const gz = villagePlacementCursor.z / CELL + (GRID_SIZE - 1) / 2;
    const anchor = resolveOrientedAnchor(model, gx, gz);
    if (anchor.col !== state.placement.col || anchor.row !== state.placement.row || anchor.rotated !== !!state.placement.rotated) {
      state.placement.col = anchor.col;
      state.placement.row = anchor.row;
      state.placement.rotated = anchor.rotated;
      updatePlacementGhost();
      saveState();
    }
  }

  if (state.placement) {
    const ghostModel = STRUCTURE_MODELS[state.placement.structureId];
    if (ghostModel) {
      villagePlacementGhost = buildPlacementGhost(ghostModel);
      villageScene.add(villagePlacementGhost.wrapper);
      const initCenter = footprintCenterWorld(state.placement.col, state.placement.row, ghostModel.w, ghostModel.h);
      villagePlacementCursor = { x: initCenter.x, z: initCenter.z };
      updatePlacementGhost();
    }
  }

  villageAvatarRoot = new THREE.Group();
  const avatarModel = new THREE.Group();
  const avatarCharacter = buildCharacter(state.character);
  avatarModel.add(avatarCharacter);
  avatarModel.scale.setScalar(VILLAGE_MODEL_SCALE);
  avatarModel.position.y = -(GROUND_Y + FOOT_MARGIN) * VILLAGE_MODEL_SCALE;
  villageAvatarRoot.add(avatarModel);
  villageAvatarRoot.position.set(spawnPoint.x, 0, spawnPoint.z);
  villageAvatarRoot.rotation.y = Math.PI;
  villageScene.add(villageAvatarRoot);

  // Start the camera already at its follow position (rather than the
  // default origin, then lerping in) so entering the screen doesn't open on
  // a jarring zoom/pan from somewhere else — pulled back to frame the whole
  // board, centered on the board itself rather than the avatar, when
  // entering straight into placement mode (see VILLAGE_CAM_*_OVERVIEW).
  const initialFocus = state.placement ? { x: 0, z: 0 } : spawnPoint;
  const initHeight = state.placement ? VILLAGE_CAM_HEIGHT_OVERVIEW : VILLAGE_CAM_HEIGHT;
  const initBack = state.placement ? VILLAGE_CAM_BACK_OVERVIEW : VILLAGE_CAM_BACK;
  const initLookHeight = state.placement ? VILLAGE_CAM_LOOK_HEIGHT_OVERVIEW : VILLAGE_CAM_LOOK_HEIGHT;
  villageCamera.position.set(initialFocus.x, initHeight, initialFocus.z + initBack);
  villageCamera.lookAt(initialFocus.x, initLookHeight, initialFocus.z);

  villageClock = new THREE.Clock();

  // On-screen joystick — replaces the old tap-a-cell-to-walk-there scheme
  // with direct analog control. The camera is fixed and never rotates, so
  // the mapping from knob offset to world direction is a straight,
  // unrotated one: screen-right is always +X (east), screen-down is always
  // +Z (south) — no camera-relative math needed.
  const JOYSTICK_MAX = 40;
  const joystickVec = { x: 0, z: 0 }; // both -1..1; magnitude is how far the knob is pushed
  villageJoystickBase = document.getElementById('villageJoystickBase');
  const joystickKnob = document.getElementById('villageJoystickKnob');
  let joystickPointerId = null;

  function updateJoystickFromEvent(e) {
    const rect = villageJoystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_MAX) {
      dx = (dx / dist) * JOYSTICK_MAX;
      dy = (dy / dist) * JOYSTICK_MAX;
    }
    joystickVec.x = dx / JOYSTICK_MAX;
    joystickVec.z = dy / JOYSTICK_MAX;
    joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function resetJoystick() {
    joystickPointerId = null;
    joystickVec.x = 0;
    joystickVec.z = 0;
    joystickKnob.style.transform = 'translate(0px, 0px)';
  }

  const onJoystickDown = (e) => {
    if (state.villageIntroStep < 2) return;
    joystickPointerId = e.pointerId;
    // Wrapped defensively — a handful of browser edge cases can throw here
    // (the pointer having already gone up in a race, mainly) and losing
    // capture is exactly the kind of thing that used to leave the joystick
    // stuck; the buttons===0 check in onJoystickMove and the window-level
    // fallbacks below still cover release even without it.
    try { villageJoystickBase.setPointerCapture(e.pointerId); } catch (err) {}
    updateJoystickFromEvent(e);
  };
  const onJoystickMove = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    // Some browsers occasionally drop the up/cancel event for a captured
    // pointer (a known class of "stuck virtual joystick" bugs — the knob
    // never springs back and the avatar keeps walking until the joystick
    // is touched again) — `buttons === 0` here means the pointer is no
    // longer actually pressed even though we never got told, so treat it
    // as a release rather than trusting only the dedicated end events.
    if (e.buttons === 0) { resetJoystick(); return; }
    updateJoystickFromEvent(e);
  };
  const onJoystickUp = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    resetJoystick();
  };
  // The joystick isn't in the DOM at all while the first-visit intro card
  // is still showing (see screenVillage()) — nothing to wire up yet in that
  // case; it gets rebuilt on the next render() once the intro is dismissed.
  if (villageJoystickBase) {
    villageJoystickHandlers = { down: onJoystickDown, move: onJoystickMove, up: onJoystickUp, reset: resetJoystick };
    villageJoystickBase.addEventListener('pointerdown', onJoystickDown);
    villageJoystickBase.addEventListener('pointermove', onJoystickMove);
    villageJoystickBase.addEventListener('pointerup', onJoystickUp);
    villageJoystickBase.addEventListener('pointercancel', onJoystickUp);
    // Fires whenever capture is released for any reason (including ones a
    // plain pointerup/pointercancel can miss), and the window-level
    // fallbacks catch a release event that lands somewhere other than the
    // joystick itself (e.g. the pointer having drifted off it) plus a tab
    // switch/app backgrounding mid-drag via `blur` — belt and suspenders
    // against the joystick ever getting stuck "on".
    villageJoystickBase.addEventListener('lostpointercapture', onJoystickUp);
    window.addEventListener('pointerup', onJoystickUp);
    window.addEventListener('pointercancel', onJoystickUp);
    window.addEventListener('blur', resetJoystick);
  }

  let walkPhase = 0;
  let walkAmount = 0;
  let talkPhase = 0;
  let talkAmount = 0;
  let talkingNpcId = null;
  let avatarSitAmount = 0;

  function animate() {
    villageAnimId = requestAnimationFrame(animate);
    const dt = Math.min(villageClock.getDelta(), 0.05);

    const mag = Math.min(1, Math.hypot(joystickVec.x, joystickVec.z));
    const pushed = mag > 0.08;
    // Pushing the joystick is always the "never mind, give me control back"
    // gesture — whether the avatar is already seated or still auto-walking
    // over to a seat (see sitDown()), standUp() clears whichever of those
    // is active so the normal joystick-movement branch below picks it up
    // the very same frame instead of needing an extra tap first.
    if (pushed && (avatarSitting || avatarSitTarget) && !state.placement && !activeDialogue) standUp();
    // The joystick drives two completely different things depending on
    // mode: the avatar normally, or the placement ghost's cursor while
    // state.placement is set (see movePlacementCursor above) — never both,
    // so the avatar always stands still during placement. It's also frozen
    // mid-conversation (activeDialogue set — see startTalking below) or
    // while sitting (avatarSitting set — see sitDown()), same as it is
    // during placement.
    const avatarMoving = pushed && !state.placement && !activeDialogue && !avatarSitting;
    // Auto-walk to a seat: same movement/turning/collision handling as the
    // avatar's own joystick-driven walk just below, just steered toward
    // avatarSitTarget.pos instead of the joystick — mirrors how a
    // wandering villager walks itself over to a POI in updateNpcMovement().
    // Collision resolution excludes the destination structure's own
    // collider (a bench/beach chair the avatar is walking onto sits right
    // on top of it) for the same reason villagers need that exclusion.
    let autoWalking = false;
    if (avatarSitTarget) {
      const pos = villageAvatarRoot.position;
      const dx = avatarSitTarget.pos.x - pos.x, dz = avatarSitTarget.pos.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.05) {
        pos.x = avatarSitTarget.pos.x;
        pos.z = avatarSitTarget.pos.z;
        villageAvatarRoot.rotation.y = avatarSitTarget.facing;
        avatarSitting = avatarSitTarget;
        avatarSitTarget = null;
      } else {
        autoWalking = true;
        const step = Math.min(dist, AVATAR_SPEED * dt);
        const dirX = dx / dist, dirZ = dz / dist;
        pos.x += dirX * step;
        pos.z += dirZ * step;
        resolveVillageCollisions(pos, AVATAR_RADIUS, (c) => c.structureId === avatarSitTarget.structureId);
        villageAvatarRoot.rotation.y = smoothAngle(villageAvatarRoot.rotation.y, Math.atan2(dirX, dirZ), dt);
      }
    } else if (avatarMoving) {
      const invMag = 1 / (Math.hypot(joystickVec.x, joystickVec.z) || 1);
      const dirX = joystickVec.x * invMag;
      const dirZ = joystickVec.z * invMag;
      const pos = villageAvatarRoot.position;
      const step = AVATAR_SPEED * mag * dt;
      pos.x += dirX * step;
      pos.z += dirZ * step;
      const margin = AVATAR_RADIUS;
      pos.x = Math.max(-GRID_HALF + margin, Math.min(GRID_HALF - margin, pos.x));
      pos.z = Math.max(-GRID_HALF + margin, Math.min(GRID_HALF - margin, pos.z));
      resolveVillageCollisions(pos, AVATAR_RADIUS);
      const targetAngle = Math.atan2(dirX, dirZ);
      villageAvatarRoot.rotation.y = smoothAngle(villageAvatarRoot.rotation.y, targetAngle, dt);
    } else if (pushed && state.placement && villagePlacementGhost) {
      const invMag = 1 / (Math.hypot(joystickVec.x, joystickVec.z) || 1);
      movePlacementCursor(joystickVec.x * invMag, joystickVec.z * invMag, AVATAR_SPEED * mag * dt);
    }

    // Walk cycle: the phase only advances while actually moving — either
    // joystick-driven or auto-walking to a seat — (so the stride doesn't
    // keep animating in place), and walkAmount eases toward 0 or 1 rather
    // than snapping, so starting/stopping doesn't pop the legs straight
    // into or out of a mid-stride pose.
    const avatarWalkingNow = avatarMoving || autoWalking;
    if (avatarWalkingNow) walkPhase += dt * 9;
    walkAmount += ((avatarWalkingNow ? 1 : 0) - walkAmount) * Math.min(1, dt * 10);
    poseWalkCycle(avatarCharacter, walkPhase, walkAmount);

    // Sit pose: same eased amount/height/bend approach as a wandering
    // villager (see poseSitCycle and the per-npc loop below) — the avatar's
    // own root position.y (always 0 otherwise) is what actually lifts it up
    // onto the seat, since avatarModel's y already holds the fixed
    // feet-on-ground offset and shouldn't be touched. The camera's own
    // height/look-at deliberately ignore followPos.y (see below), so this
    // small lift never perturbs the view.
    avatarSitAmount += ((avatarSitting ? 1 : 0) - avatarSitAmount) * Math.min(1, dt * 10);
    poseSitCycle(avatarCharacter, avatarSitAmount, avatarSitting ? avatarSitting.sitBend : NPC_SIT_BEND);
    villageAvatarRoot.position.y =
      (avatarSitting ? Math.max(0, avatarSitting.sitHeight - seatedBodyDrop()) : 0) * avatarSitAmount;

    // Ambient villager wandering: each villager runs its own little
    // idle/walk/interact loop (see updateNpcMovement) completely
    // independently of the avatar and the camera — frozen only for
    // whichever villager the player is currently mid-conversation with, so
    // a dialogue partner never wanders off mid-sentence. Walk/sit poses use
    // their own per-npc phase/amount, the same ease-in/ease-out convention
    // as the avatar's walkAmount above, so several villagers can be at
    // different points in their own stride at once without interfering.
    villageNpcs.forEach((npc) => {
      if (!npc.behavior) return;
      const isTalkPartner = activeDialogue && activeDialogue.npc === npc;
      if (!isTalkPartner) updateNpcMovement(npc, dt);
      const npcMoving = npc.behavior.mode === 'walking';
      const npcSitting = npc.behavior.mode === 'interacting' && npc.behavior.dest && npc.behavior.dest.kind === 'sit';
      // Idle covers everything else — standing at home or observing a
      // structure — so a villager never reads as frozen when they're not
      // actively walking, sitting, or (see isTalkPartner above) talking.
      const npcIdle = !npcMoving && !npcSitting && !isTalkPartner;
      if (npcMoving) npc.walkPhase += dt * 7;
      if (npcIdle) npc.idlePhase += dt;
      npc.walkAmount += ((npcMoving ? 1 : 0) - npc.walkAmount) * Math.min(1, dt * 10);
      npc.sitAmount += ((npcSitting ? 1 : 0) - npc.sitAmount) * Math.min(1, dt * 10);
      npc.idleAmount += ((npcIdle ? 1 : 0) - npc.idleAmount) * Math.min(1, dt * 10);
      poseWalkCycle(npc.characterModel, npc.walkPhase, npc.walkAmount);
      poseSitCycle(npc.characterModel, npc.sitAmount, npc.sitBend);
      poseIdleCycle(npc.characterModel, npc.idlePhase, npc.idleAmount, npc.idleSeed);
      // Same seat-surface-vs-root correction the player gets — villagers were
      // hovering over the benches for exactly the same reason.
      npc.root.position.set(npc.pos.x, Math.max(0, npc.sitHeight - seatedBodyDrop()) * npc.sitAmount, npc.pos.z);
      npc.wrapper.rotation.y = npc.facingAngle;
      npc.collider.x = npc.pos.x;
      npc.collider.z = npc.pos.z;
    });

    // Talk cycle: whichever villager is (or just was) in the open dialogue
    // gets their mouth/arms animated (see poseTalkCycle) — same
    // ease-in/ease-out pattern as the walk cycle above, so the gesture
    // settles back to rest smoothly instead of snapping still the instant
    // the dialogue box closes. `talkingNpcId` keeps pointing at the last
    // villager talked to for as long as it takes talkAmount to ease to 0,
    // then goes idle so this lookup stops running for nothing every frame.
    const talking = !!activeDialogue;
    if (talking) talkPhase += dt * 10;
    talkAmount += ((talking ? 1 : 0) - talkAmount) * Math.min(1, dt * 10);
    if (talking) talkingNpcId = activeDialogue.npc.id;
    if (talkingNpcId) {
      const talkingNpc = villageNpcs.find((n) => n.id === talkingNpcId);
      if (talkingNpc && talkingNpc.characterModel) poseTalkCycle(talkingNpc.characterModel, talkPhase, talkAmount);
      if (!talking && talkAmount < 0.01) talkingNpcId = null;
    }

    // Camera keeps the same fixed tilt at all times (translate-only, never
    // rotates) — smoothed with a lerp so it trails a beat behind rather than
    // snapping, which is what keeps a "following" camera from feeling
    // mechanical. Normally it's re-centered on the avatar every frame; while
    // placing a structure it instead pulls back to a fixed frame on the
    // whole board (see VILLAGE_CAM_*_OVERVIEW) so the player can see every
    // open cell while steering the ghost, rather than following the ghost
    // around a tight view.
    const followPos = state.placement ? { x: 0, z: 0 } : villageAvatarRoot.position;
    const camHeight = state.placement ? VILLAGE_CAM_HEIGHT_OVERVIEW : VILLAGE_CAM_HEIGHT;
    const camBack = state.placement ? VILLAGE_CAM_BACK_OVERVIEW : VILLAGE_CAM_BACK;
    const camLookHeight = state.placement ? VILLAGE_CAM_LOOK_HEIGHT_OVERVIEW : VILLAGE_CAM_LOOK_HEIGHT;
    const desiredCamPos = { x: followPos.x, y: camHeight, z: followPos.z + camBack };
    const camLerp = 1 - Math.pow(0.001, dt);
    villageCamera.position.x += (desiredCamPos.x - villageCamera.position.x) * camLerp;
    villageCamera.position.y += (desiredCamPos.y - villageCamera.position.y) * camLerp;
    villageCamera.position.z += (desiredCamPos.z - villageCamera.position.z) * camLerp;
    villageCamera.lookAt(followPos.x, camLookHeight, followPos.z);

    // Whichever villager the avatar is standing closest to, if any is within
    // TALK_RADIUS — never while placing a structure or mid-conversation, so
    // the button can't pop up over the placement UI or while a dialogue box
    // is already open.
    if (state.placement || activeDialogue) {
      nearbyTalkNpc = null;
    } else {
      let nearest = null, nearestDist = TALK_RADIUS;
      villageNpcs.forEach((npc) => {
        // npc.pos is their live, possibly-wandering position — npc.center
        // is just their fixed home spot, which would leave the Talk button
        // pointing at an empty patch of grass once they've wandered off.
        const d = Math.hypot(npc.pos.x - villageAvatarRoot.position.x, npc.pos.z - villageAvatarRoot.position.z);
        if (d < nearestDist) { nearestDist = d; nearest = npc; }
      });
      nearbyTalkNpc = nearest;
    }
    const talkBtn = document.getElementById('villageTalkBtn');
    if (talkBtn) talkBtn.style.display = nearbyTalkNpc ? '' : 'none';

    // The player's own "Sit" prompt — same shape as the Talk one above,
    // just over villagePOIs' empty 'sit' spots instead of villagers. No
    // search needed while already sitting OR mid-walk-over to a seat
    // (nearbySeat only matters for finding a *new* seat to offer, and
    // re-triggering the search during the walk-over could dangle a "Sit"
    // prompt for some other seat passed along the way) — the button shows
    // "Stand" throughout both of those states instead, handled below.
    if (state.placement || activeDialogue || avatarSitting || avatarSitTarget) {
      nearbySeat = null;
    } else {
      const claimed = claimedPoiIds(null);
      let nearest = null, nearestDist = SIT_RADIUS;
      villagePOIs.forEach((poi) => {
        if (poi.kind !== 'sit' || claimed.has(poi.poiId)) return;
        const d = Math.hypot(poi.pos.x - villageAvatarRoot.position.x, poi.pos.z - villageAvatarRoot.position.z);
        if (d < nearestDist) { nearestDist = d; nearest = poi; }
      });
      nearbySeat = nearest;
    }
    const sitBtn = document.getElementById('villageSitBtn');
    if (sitBtn) {
      if (avatarSitting || avatarSitTarget) {
        sitBtn.style.display = '';
        sitBtn.textContent = 'Stand';
      } else if (nearbySeat) {
        sitBtn.style.display = '';
        sitBtn.textContent = 'Sit';
      } else {
        sitBtn.style.display = 'none';
      }
    }

    // The "Enter" prompt for the town hall's front doors — same shape as
    // Talk/Sit above, just a single fixed point instead of a list.
    const doorsBlocked = state.placement || activeDialogue || avatarSitting || avatarSitTarget;
    if (doorsBlocked) {
      nearbyTownHallDoor = false;
    } else {
      const doorPos = getTownHallDoorPoint();
      nearbyTownHallDoor = Math.hypot(doorPos.x - villageAvatarRoot.position.x, doorPos.z - villageAvatarRoot.position.z) < ENTER_RADIUS;
    }
    const enterBtn = document.getElementById('villageEnterBtn');
    if (enterBtn) enterBtn.style.display = nearbyTownHallDoor ? '' : 'none';

    // The party hall's own front doors. getPartyHallDoorPoint() returns null
    // when the town hasn't bought one yet, which is the normal case early on
    // — not an error, just nothing to stand in front of.
    const partyDoorPos = doorsBlocked ? null : getPartyHallDoorPoint();
    nearbyPartyHallDoor = !!partyDoorPos &&
      Math.hypot(partyDoorPos.x - villageAvatarRoot.position.x, partyDoorPos.z - villageAvatarRoot.position.z) < ENTER_RADIUS;
    const partyEnterBtn = document.getElementById('villagePartyEnterBtn');
    if (partyEnterBtn) partyEnterBtn.style.display = nearbyPartyHallDoor ? '' : 'none';

    // The player's own front door. Always present — unlike the party hall,
    // the house is part of the fixed layout from day one.
    const homeDoorPos = getPlayerHouseDoorPoint();
    nearbyPlayerHouseDoor = !doorsBlocked &&
      Math.hypot(homeDoorPos.x - villageAvatarRoot.position.x, homeDoorPos.z - villageAvatarRoot.position.z) < ENTER_RADIUS;
    const homeEnterBtn = document.getElementById('villageHomeEnterBtn');
    if (homeEnterBtn) homeEnterBtn.style.display = nearbyPlayerHouseDoor ? '' : 'none';

    villageRenderer.render(villageScene, villageCamera);
  }
  animate();
}

// The player's own version of a villager sitting down — the "Sit" button
// (see the proximity check in animate()) only ever points at a real,
// currently-empty seat, so this just hands it off as `avatarSitTarget`;
// animate()'s auto-walk block (mirroring updateNpcMovement's own
// walk-then-arrive logic for villagers) actually walks the avatar over
// there and only sets `avatarSitting` — which is what holds the avatar in
// place and poses it seated — once it truly arrives.
function sitDown() {
  if (!nearbySeat || state.placement || activeDialogue || avatarSitting || avatarSitTarget) return;
  avatarSitTarget = nearbySeat;
  nearbySeat = null;
}

// Standing back up just clears the sit state (whichever half of it is
// active — already seated, or still mid-walk-over) — animate() eases the
// pose back to standing on its own (same amount-based easing as everything
// else here), and pushing the joystick calls this too, so walking away (or
// changing your mind mid-approach) is itself the "get up"/"cancel" gesture,
// not just the button.
function standUp() {
  // Step off the seat before clearing the state. The seat POI is the bench's
  // own centre and the collision resolver only runs while the player is
  // moving, so just dropping the flag left them standing inside the bench
  // with nothing to push them out. `facing` is the direction they were
  // sitting in, so stepping that way is stepping out in front of the seat.
  if (avatarSitting && villageAvatarRoot) {
    const facing = avatarSitting.facing || 0;
    const pos = villageAvatarRoot.position;
    pos.x += Math.sin(facing) * SEAT_EXIT_STEP;
    pos.z += Math.cos(facing) * SEAT_EXIT_STEP;
    pos.y = 0;
    resolveVillageCollisions(pos, AVATAR_RADIUS);
  }
  avatarSitting = null;
  avatarSitTarget = null;
}

function toggleSit() {
  if (avatarSitting || avatarSitTarget) standUp();
  else sitDown();
}

// Opens the dialogue box for whichever villager the "Talk" button is
// currently pointing at (see the proximity check in animate() above) — the
// first-meeting script (with the name-buddy easter egg) if this is the
// player's first conversation with them, otherwise a simple repeat line.
function startTalking() {
  if (!nearbyTalkNpc || activeDialogue) return;
  const npc = nearbyTalkNpc;
  const lines = hasMetVillager(npc) ? [repeatVisitLine(npc)] : firstMeetingLines(npc);
  activeDialogue = { npc, lines, index: 0 };
  renderDialogueBox();
}

function renderDialogueBox() {
  if (!activeDialogue) return;
  const overlay = document.getElementById('villageDialogueOverlay');
  const nameEl = document.getElementById('villageDialogueName');
  const textEl = document.getElementById('villageDialogueText');
  const talkBtn = document.getElementById('villageTalkBtn');
  if (!overlay || !nameEl || !textEl) return;
  nameEl.textContent = activeDialogue.npc.name || '';
  textEl.textContent = activeDialogue.lines[activeDialogue.index];
  overlay.style.display = '';
  if (talkBtn) talkBtn.style.display = 'none';
}

// Tapping the open dialogue box advances to its next line, or — once the
// last line's been shown — closes it and marks the villager met so any
// future conversation gets the repeat line instead of the first-meeting
// script.
function advanceDialogue() {
  if (!activeDialogue) return;
  activeDialogue.index += 1;
  if (activeDialogue.index >= activeDialogue.lines.length) {
    markVillagerMet(activeDialogue.npc);
    activeDialogue = null;
    const overlay = document.getElementById('villageDialogueOverlay');
    if (overlay) overlay.style.display = 'none';
    return;
  }
  renderDialogueBox();
}

let emptyVillagePreviewRenderer = null;

function teardownEmptyVillagePreview() {
  if (emptyVillagePreviewRenderer) {
    emptyVillagePreviewRenderer.dispose();
    if (emptyVillagePreviewRenderer.forceContextLoss) emptyVillagePreviewRenderer.forceContextLoss();
    emptyVillagePreviewRenderer = null;
  }
}

// A static, one-frame render of the starting town — town hall + the three
// homes, on the same ground/forest/water as the real Village screen — for
// the "your village is empty" onboarding screen, replacing the old plain
// "empty plot" placeholder. No avatar, no NPCs, deliberately no characters
// at all, just a preview of the place itself. Nothing here moves, so unlike
// initVillageScene() there's no animate() loop — it renders once and stops.
// Kept as its own standalone setup (some duplication with initVillageScene)
// rather than sharing code with it, so tweaking this preview can't risk
// regressing the real gameplay scene.
function initEmptyVillagePreviewScene() {
  teardownEmptyVillagePreview();
  const holder = document.getElementById('emptyVillagePreview');
  if (!holder || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xA2C4D5);
  scene.fog = new THREE.Fog(0xA2C4D5, 24, 58);

  const camera = new THREE.PerspectiveCamera(50, holder.clientWidth / holder.clientHeight, 0.1, 220);
  camera.position.set(0, 20, 14.5);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(holder.clientWidth, holder.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 0.85;
  holder.appendChild(renderer.domElement);
  emptyVillagePreviewRenderer = renderer;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x4CAF6D, 0.78);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d0, 0.95);
  sun.position.set(6, 12, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  scene.add(sun);

  const backdrop = new THREE.Mesh(
    new THREE.BoxGeometry(400, 0.3, 400),
    new THREE.MeshStandardMaterial({ color: 0x6FCB6F, roughness: 0.95 })
  );
  backdrop.position.y = -0.22;
  backdrop.receiveShadow = true;
  scene.add(backdrop);

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_SIZE * CELL, GRID_SIZE * CELL),
    new THREE.MeshStandardMaterial({ map: makeGroundGridTexture(), roughness: 0.95 })
  );
  board.rotation.x = -Math.PI / 2;
  board.receiveShadow = true;
  scene.add(board);

  buildForestWall(scene);
  buildWaterBorder(scene);

  const mid = Math.floor((GRID_SIZE - 3) / 2);
  placeVillageWorld(scene, mid + 1, mid + 3, { includeNpcs: false });

  renderer.render(scene, camera);
}

function getQuestById(id) {
  return QUESTS.find(q => q.id === id);
}

// The tier a quest is currently offered at. Rolled once, then remembered, so
// a card shows the same length and payout every render until it's shuffled
// away or completed. Saves from before tiers existed land here with nothing
// stored and simply get a roll on first sight.
function questTierIndex(id) {
  if (!state.questTiers) state.questTiers = {};
  if (typeof state.questTiers[id] !== 'number') {
    const q = getQuestById(id);
    state.questTiers[id] = q ? Math.floor(Math.random() * q.tiers.length) : 0;
  }
  return state.questTiers[id];
}

// A quest resolved to the tier it's being offered at: same fields as the
// quest plus concrete `minutes` and `coins`. Everything that renders or pays
// out a quest goes through this rather than reading the raw entry.
function questView(id) {
  const q = getQuestById(id);
  if (!q) return null;
  const tier = questTierIndex(id);
  return { ...q, minutes: q.tiers[tier], coins: coinsForTier(tier) };
}

function pickQuests(count, excludeIds) {
  const exclude = excludeIds || [];
  // Only what's already on the board is off-limits — nothing is retired for
  // good. Past completions push a quest down the order rather than out of it.
  const available = QUESTS.filter(q => !exclude.includes(q.id));
  const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
  const matches = q => !state.triggers.length || state.triggers.includes(q.tag);

  // Preference order, best first. Never-done beats trigger match, so a player
  // who picked a thin tag (Anxiety, Late at night and Other have one quest
  // each) still sees new material instead of the same card forever. The last
  // group ignores the cooldown entirely and exists only so the board can
  // always be filled — oldest completion first, so the stalest comes back.
  const groups = [
    shuffle(available.filter(q => !questLastCompletedAt(q.id) && matches(q))),
    shuffle(available.filter(q => !questLastCompletedAt(q.id) && !matches(q))),
    shuffle(available.filter(q => questLastCompletedAt(q.id) && questIsRested(q.id) && matches(q))),
    shuffle(available.filter(q => questLastCompletedAt(q.id) && questIsRested(q.id) && !matches(q))),
    available.filter(q => questLastCompletedAt(q.id) && !questIsRested(q.id))
             .sort((a, b) => questLastCompletedAt(a.id) - questLastCompletedAt(b.id)),
  ];
  return groups.flat().slice(0, count).map(q => q.id);
}

function pinnedQuestIds() {
  return [...state.startedQuestIds];
}

function fillQuestsShown(keepFillers) {
  const pinned = pinnedQuestIds();
  const fillers = (keepFillers || []).filter(id => !pinned.includes(id));
  const merged = [...pinned, ...fillers];
  const needed = Math.max(0, 3 - merged.length);
  state.questsShown = [...merged, ...pickQuests(needed, merged)];
  // Drop rolled tiers for quests that are no longer on the board or in
  // progress, so one that comes back around later can be offered at a
  // different length instead of being stuck at the tier it first rolled.
  const keep = new Set([...state.questsShown, ...state.startedQuestIds]);
  for (const id of Object.keys(state.questTiers || {})) {
    if (!keep.has(id)) delete state.questTiers[id];
  }
}

function ensureQuestsShown() {
  const pinned = pinnedQuestIds();
  const shownValid = state.questsShown.filter(id => getQuestById(id));
  const hasAllPinned = pinned.every(id => shownValid.includes(id));
  if (shownValid.length !== state.questsShown.length || !hasAllPinned || shownValid.length < 3) {
    fillQuestsShown(shownValid);
    saveState();
  }
}

// Rerolling the board costs coins, so it's a real choice rather than a free
// slot machine you pull until you get the shortest quest going.
const REROLL_COST = 20;

// Quests you've already started stay pinned through a reroll, so if every
// slot is pinned there is nothing a reroll could change — charging for that
// would take coins and hand back the same board.
function rerollableCount() {
  return state.questsShown.filter(id => !state.startedQuestIds.includes(id)).length;
}

function shuffleQuests() {
  if (!rerollableCount()) return;
  if (!canAfford(REROLL_COST)) return;
  spendCoins(REROLL_COST);
  fillQuestsShown([]);
  saveState();
  render();
}

function openQuest(id) {
  state.activeQuestId = id;
  goTo('questDetail');
}

function startQuest(id) {
  if (!state.startedQuestIds.includes(id)) {
    state.startedQuestIds.push(id);
  }
  const pinned = pinnedQuestIds();
  const rest = state.questsShown.filter(qid => !pinned.includes(qid));
  state.questsShown = [...pinned, ...rest];
  state.activeQuestId = null;
  goBack();
}

function resumeQuest(id) {
  state.activeQuestId = id;
  goTo('verify');
}

// What the reward screen checks so it never tells someone to go build with
// coins they can't spend. Structures already placed don't count — every one
// except Garden Patch is a one-time buy (see isStructurePurchased), so
// "affordable" has to mean "affordable AND still for sale". Home furniture
// can be bought over and over, so price is the only thing that matters there.
function buyableStructures() {
  return STRUCTURES.filter(s => !isStructurePurchased(s.id));
}

function canBuildInTown() {
  return buyableStructures().some(s => canAfford(s.cost));
}

function canBuyForHome() {
  return HOME_ITEMS.some(it => canAfford(it.cost));
}

// Coins still needed for the cheapest structure that's still for sale.
// Garden Patch never sells out, so there's always a next thing to save for.
function coinsUntilTownBuild() {
  const costs = buyableStructures().map(s => s.cost);
  if (!costs.length) return 0;
  return Math.max(0, Math.min(...costs) - state.coins);
}

// Enters the house the same way walking in does — village, then inside, then
// the catalogue — so Back inside and walking out the door land exactly where
// they would if the player had come in on foot.
function goShopForHome() {
  state.history.push(state.screen, 'village', 'homeInterior');
  state.screen = 'homeShop';
  state.homeShopTab = 'buy';
  saveState();
  render();
}

function completeQuest() {
  const q = questView(state.activeQuestId);
  if (!q) { goTo('quests'); return; }
  const note = document.getElementById('verifyNote');
  if (note && countWords(note.value) < VERIFY_MIN_WORDS) return;
  // The write-up is the whole point of the verify step, so it's kept rather
  // than just counted. Title/tag/length are snapshotted alongside it: quest
  // wording and durations can change later, and an entry should stay a true
  // record of the quest as it was done.
  if (!Array.isArray(state.journal)) state.journal = [];
  state.journal.push({
    id: `j-${Date.now()}`,
    questId: q.id,
    title: q.title,
    tag: q.tag,
    minutes: q.minutes,
    coins: q.coins,
    text: note ? note.value.trim() : '',
    at: Date.now(),
  });
  state.coins += q.coins;
  if (!state.completedQuestIds.includes(q.id)) state.completedQuestIds.push(q.id);
  if (!state.questCompletedAt) state.questCompletedAt = {};
  state.questCompletedAt[q.id] = Date.now();
  state.questsShown = state.questsShown.filter(id => id !== q.id);
  state.startedQuestIds = state.startedQuestIds.filter(id => id !== q.id);
  state.lastReward = { coins: q.coins };
  state.activeQuestId = null;
  goTo('reward');
}

// ---------- Journal ----------
// Every quest write-up, newest first. The list shows an opening snippet; the
// whole entry lives on its own screen so a page of 100-word reflections
// doesn't become an endless scroll.
function journalEntries() {
  return Array.isArray(state.journal) ? [...state.journal].reverse() : [];
}

function formatJournalDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function journalSnippet(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? `${clean.slice(0, 120).trimEnd()}…` : clean;
}

function openJournalEntry(id) {
  state.activeJournalId = id;
  goTo('journalEntry');
}

function screenJournal() {
  const entries = journalEntries();
  const body = entries.length
    ? entries.map(e => `
        <div class="card quest-card" onclick="openJournalEntry('${e.id}')">
          <span class="tag">${escapeHtml(e.tag || '')}</span>
          <div class="txt" style="font-size:13px;">${escapeHtml(e.title || 'A quest')}</div>
          <div class="txt soft tiny">${formatJournalDate(e.at)}</div>
          <div class="txt soft tiny">${escapeHtml(journalSnippet(e.text))}</div>
        </div>`).join('')
    : `<div class="card"><div class="txt soft tiny">Nothing here yet. Everything you write after finishing a quest gets kept here, just for you.</div></div>`;
  return `
    <div class="screen">
      ${backButton()}
      <div class="txt" style="font-size:15px;">Your journal</div>
      <div class="txt soft tiny">${entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} — every time you reached out.` : 'A record of every quest you\'ve finished.'}</div>
      ${body}
      ${renderNavbar('quests')}
    </div>
  `;
}

function screenJournalEntry() {
  const entry = journalEntries().find(e => e.id === state.activeJournalId);
  if (!entry) {
    goTo('journal');
    return '';
  }
  return `
    <div class="screen">
      ${backButton()}
      <span class="tag">${escapeHtml(entry.tag || '')}</span>
      <div class="txt" style="font-size:17px;">${escapeHtml(entry.title || 'A quest')}</div>
      <div class="txt soft tiny">${formatJournalDate(entry.at)}${entry.minutes ? ` · ${formatDuration(entry.minutes)}` : ''}${entry.coins ? ` +${entry.coins} 🪙` : ''}</div>
      <div class="card">
        <div class="txt soft journal-body">${escapeHtml(entry.text || '')}</div>
      </div>
      <div class="spacer"></div>
      <button class="btn ghost" onclick="goBack()">Back to journal</button>
    </div>
  `;
}

function screenSettings() {
  const row = (label, value, action) => `
    <div class="card settings-row" onclick="${action}">
      <div class="settings-row-text">
        <div class="txt tiny">${label}</div>
        <div class="txt soft tiny">${value}</div>
      </div>
      <div class="txt soft tiny settings-chevron">›</div>
    </div>`;
  const triggers = state.triggers.length ? state.triggers.join(', ') : 'Prefer not to say';
  return `
    <div class="screen">
      <div class="txt" style="font-size:15px;">Settings</div>
      <div class="section-label">You</div>
      ${row('Your name', escapeHtml(state.name) || 'Not set', "goTo('name')")}
      ${row('Your look', 'Change your character', "goTo('character')")}
      <div class="section-label">Your town</div>
      ${row('Town name', escapeHtml(state.villageName) || 'Not set', "goTo('villageName')")}
      ${row('Quest triggers', escapeHtml(triggers), "goTo('triggers')")}
      <div class="section-label">Advanced settings</div>
      <div class="card">
        <div class="txt tiny">Start over</div>
        <div class="txt soft tiny">Erases your town, your villagers, your home and all your progress. There's no way to undo this and no backup.</div>
        <button class="btn ghost" style="margin-top:10px;" onclick="confirmStartOver()">Start over</button>
      </div>
      ${renderNavbar('settings')}
    </div>
  `;
}

// Deliberately a two-step confirm rather than a single tap: this is the only
// destructive action in the app and there is no undo and no cloud backup.
function confirmStartOver() {
  const ok = confirm(`Start over?\n\nThis erases ${state.villageName || 'your town'}, your villagers, your home and all your progress. It cannot be undone.`);
  if (ok) resetApp();
}

function renderNavbar(active, tutorialMode) {
  // Inside the player's own house the Structures tab points at the home's
  // catalogue instead of the town's — the same tab in the same place, but
  // what you can build is whatever building you happen to be standing in.
  const inHome = state.screen === 'homeInterior' || state.screen === 'homeShop';
  const items = [
    { id: 'quests', label: 'Quests' },
    { id: 'village', label: 'Town' },
    { id: inHome ? 'homeShop' : 'structureShop', label: 'Structures' },
    { id: 'settings', label: 'Settings' },
  ];
  return `
    <div class="navbar">
      ${items.map(it => {
        const isTarget = tutorialMode && active === it.id;
        return `
          <div class="navitem ${active === it.id ? 'active' : ''} ${isTarget ? 'tutorial-target' : ''}" data-tab="${it.id}" onclick="${tutorialMode ? `handleTutorialNavClick('${it.id}')` : `goTo('${it.id}')`}">
            <div class="dot"></div>${it.label}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ---------- Core app screens ----------

function screenQuests() {
  ensureQuestsShown();
  const list = state.questsShown.map(questView).filter(Boolean);
  return `
    <div class="screen">
      <div class="txt" style="font-size:15px;">Quests for you</div>
      <div class="txt soft tiny">You have 🪙 ${coinsLabel()}</div>
      ${list.length ? list.map(q => {
        const started = state.startedQuestIds.includes(q.id);
        if (started) {
          return `
            <div class="card quest-card started">
              <span class="tag">${q.tag}</span>
              <div class="txt" style="font-size:13px;">${escapeHtml(q.title)}</div>
              <div class="txt soft tiny">~${formatDuration(q.minutes)} +${q.coins} 🪙</div>
              <button class="btn sage" style="margin-top:8px;" onclick="resumeQuest('${q.id}')">Complete quest</button>
            </div>
          `;
        }
        return `
          <div class="card quest-card" onclick="openQuest('${q.id}')">
            <span class="tag">${q.tag}</span>
            <div class="txt" style="font-size:13px;">${escapeHtml(q.title)}</div>
            <div class="txt soft tiny">~${formatDuration(q.minutes)} +${q.coins} 🪙</div>
          </div>
        `;
      }).join('') : `<div class="card"><div class="txt soft tiny">Nothing on the board right now — tap "New quests" to pull a fresh set.</div></div>`}
      <button class="btn ghost" onclick="shuffleQuests()" ${rerollableCount() && canAfford(REROLL_COST) ? '' : 'disabled'}>New quests ${REROLL_COST} 🪙</button>
      ${rerollableCount() ? (canAfford(REROLL_COST) ? '' : `<div class="txt soft tiny center">${REROLL_COST - state.coins} more coins to reroll.</div>`) : `<div class="txt soft tiny center">Finish or drop a quest to reroll the board.</div>`}
      <button class="btn link" style="align-self:center;" onclick="goTo('journal')">Your journal${journalEntries().length ? ` (${journalEntries().length})` : ''}</button>
      ${renderNavbar('quests')}
    </div>
  `;
}

function screenQuestDetail() {
  const q = questView(state.activeQuestId);
  if (!q) {
    goTo('quests');
    return '';
  }
  return `
    <div class="screen">
      ${backButton()}
      <span class="tag">${q.tag}</span>
      <div class="txt" style="font-size:17px;">${escapeHtml(q.title)}</div>
      <div class="txt soft" style="font-size:13px; line-height:1.5;">${escapeHtml(q.desc)}</div>
      <div class="txt soft tiny">Set aside about ${formatDuration(q.minutes)} — Reward: +${q.coins} 🪙</div>
      <div class="spacer"></div>
      <button class="btn" onclick="startQuest('${q.id}')">Start quest</button>
      <button class="btn ghost" onclick="goBack()">Not right now</button>
    </div>
  `;
}

const VERIFY_MIN_WORDS = 75;

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function screenVerify() {
  return `
    <div class="screen">
      ${backButton()}
      <div class="txt" style="font-size:15px;">How'd it go?</div>
      <div class="txt soft tiny">Write about your experience. This is just for you.</div>
      <textarea id="verifyNote" placeholder="Write a little about it..." oninput="updateWordCount()"></textarea>
      <div class="txt soft tiny" id="wordCount">0 / ${VERIFY_MIN_WORDS} words</div>
      <div class="spacer"></div>
      <button class="btn" id="completeQuestBtn" disabled onclick="completeQuest()">Complete quest</button>
    </div>
  `;
}

function updateWordCount() {
  const note = document.getElementById('verifyNote');
  const count = countWords(note.value);
  document.getElementById('wordCount').textContent = `${count} / ${VERIFY_MIN_WORDS} words`;
  document.getElementById('completeQuestBtn').disabled = count < VERIFY_MIN_WORDS;
}

function screenReward() {
  const r = state.lastReward || { coins: 0 };
  const town = escapeHtml(state.villageName);
  // Checked against the live balance rather than a snapshot from when the
  // quest finished, so coming back here after a purchase stays accurate.
  const short = coinsUntilTownBuild();
  const shortLabel = `${short} more coin${short === 1 ? '' : 's'}`;

  let message, actions;
  if (canBuildInTown()) {
    message = `${town} deserves an upgrade now, so let's go give it one!`;
    actions = `
      <button class="btn sage" onclick="goTo('village')">Go build</button>
      <button class="btn ghost" onclick="goTo('quests')">Back to quests</button>`;
  } else if (canBuyForHome()) {
    message = `${shortLabel} until you can build in ${town} \u2014 but you've got enough to grab something for your house.`;
    actions = `
      <button class="btn sage" onclick="goShopForHome()">Shop for your house</button>
      <button class="btn ghost" onclick="goTo('quests')">Back to quests</button>`;
  } else {
    message = `${shortLabel} until you can build in ${town}. Keep it up!`;
    actions = `
      <button class="btn" onclick="goTo('quests')">Back to quests</button>`;
  }

  return `
    <div class="screen" style="align-items:center; text-align:center; justify-content:center;">
      ${backButton()}
      <div class="txt" style="font-size:16px;">Sounds like a nice time! Good Work!</div>
      <div class="coin" style="margin:8px 0;">+${r.coins} 🪙</div>
      <div class="txt soft tiny">${message}</div>
      <div class="spacer"></div>
      ${actions}
    </div>
  `;
}

function villageIntroText() {
  if (state.villageIntroStep === 0) {
    return `Welcome to ${escapeHtml(state.villageName)}! You're the mayor of this brand new town.`;
  }
  return `You've got a town hall in the center, your own home, and homes of two other villagers. Not much — so make this town bustling!`;
}

function advanceVillageIntro() {
  state.villageIntroStep = Math.min(2, state.villageIntroStep + 1);
  saveState();
  render();
}

// Cancels out of placement mode back to the shop without spending
// anything — the structure was never added to state.village, only staged
// in state.placement, so there's nothing to undo besides clearing that.
function cancelPlacement() {
  state.placement = null;
  goBack();
}

// Reads the ghost's last validated position/validity straight off
// state.placement (kept in sync by updatePlacementGhost on every tap — see
// initVillageScene) rather than recomputing here, so this can't disagree
// with what the player actually saw highlighted on screen.
function confirmPlacement() {
  const placement = state.placement;
  if (!placement || !placement.valid) return;
  const s = STRUCTURES.find(x => x.id === placement.structureId);
  const model = STRUCTURE_MODELS[placement.structureId];
  if (!s || !model || !canAfford(s.cost)) return;
  spendCoins(s.cost);
  state.village.push({ id: `${s.id}-${Date.now()}`, type: s.id, col: placement.col, row: placement.row, rotated: !!placement.rotated });
  const villagersBefore = state.villagers.length;
  maybeSpawnVillager(s.id);
  const movedIn = state.villagers.length > villagersBefore;
  state.placement = null;
  saveState();
  render();
  if (movedIn) alert(`Building the ${s.name} drew a new neighbor to ${state.villageName} — check out their new house!`);
}

function screenVillage() {
  const introActive = state.villageIntroStep < 2;
  const placing = state.placement;
  const placingName = placing ? (STRUCTURES.find(x => x.id === placing.structureId) || {}).name : '';
  return `
    <div class="screen village-screen">
      <div class="village-plot" style="position:relative; padding:0;">
        <div id="villageScene" style="position:absolute; inset:0;"></div>
        ${placing ? `
          <div class="village-overlay-top placement-hint-row">
            <div class="placement-hint">Use the joystick to move the ${escapeHtml(placingName)}</div>
          </div>
          <div class="joystick-base" id="villageJoystickBase">
            <div class="joystick-knob" id="villageJoystickKnob"></div>
          </div>
          <div class="placement-bar">
            <button class="btn ghost" onclick="cancelPlacement()">Cancel</button>
            <button class="btn" id="placementConfirmBtn" ${placing.valid ? '' : 'disabled'} onclick="confirmPlacement()">Place here</button>
          </div>
        ` : `
          <div class="village-overlay-top">
            <div class="chip-row">
              <span class="chip on">My town</span>
            </div>
          </div>
          ${introActive ? `
            <div class="village-intro-overlay" onclick="advanceVillageIntro()">
              <div class="village-intro-card">${villageIntroText()}</div>
            </div>
          ` : `
            <div class="joystick-base" id="villageJoystickBase">
              <div class="joystick-knob" id="villageJoystickKnob"></div>
            </div>
            <div class="village-action-row">
              <button class="talk-btn" id="villageEnterBtn" style="display:none;" onclick="enterTownHall()">Enter</button>
              <button class="talk-btn" id="villagePartyEnterBtn" style="display:none;" onclick="enterPartyHall()">Enter</button>
              <button class="talk-btn" id="villageHomeEnterBtn" style="display:none;" onclick="enterHome()">Enter</button>
              <button class="talk-btn" id="villageSitBtn" style="display:none;" onclick="toggleSit()">Sit</button>
              <button class="talk-btn" id="villageTalkBtn" style="display:none;" onclick="startTalking()">Talk</button>
            </div>
            <div class="village-dialogue-overlay" id="villageDialogueOverlay" style="display:none;" onclick="advanceDialogue()">
              <div class="village-dialogue-card">
                <div class="village-dialogue-name" id="villageDialogueName"></div>
                <div class="village-dialogue-text" id="villageDialogueText"></div>
                <div class="village-dialogue-hint">Tap to continue</div>
              </div>
            </div>
          `}
          <button class="btn link village-reset-link" onclick="resetApp()">Reset app (dev)</button>
        `}
      </div>
      ${renderNavbar('village')}
    </div>
  `;
}

let structureShopAnimId = null;
let structurePreviewScenes = [];

function teardownStructureShopScene() {
  if (structureShopAnimId !== null) cancelAnimationFrame(structureShopAnimId);
  structureShopAnimId = null;
  structurePreviewScenes.forEach((p) => {
    p.renderer.dispose();
    if (p.renderer.forceContextLoss) p.renderer.forceContextLoss();
  });
  structurePreviewScenes = [];
}

// Each shop card gets its own tiny real Three.js scene rendering the exact
// same model builder used out in the village (STRUCTURE_MODELS), rather than
// an emoji — same low-poly real-3D look, lit and slowly spinning so it reads
// as an actual object you're about to place, not a static icon.
function initStructureShopScene() {
  teardownStructureShopScene();
  if (typeof THREE === 'undefined') return;

  STRUCTURES.forEach((s) => {
    const holder = document.querySelector(`[data-structure-canvas="${s.id}"]`);
    const model = STRUCTURE_MODELS[s.id];
    if (!holder || !model) return;

    // Fixed internal resolution matching the card's CSS aspect ratio, with
    // updateStyle:false so Three.js never writes an inline canvas width/height
    // — the stylesheet's width:100%/height:100% is what actually sizes it on
    // screen. Reading the holder's live clientWidth here instead was flaky:
    // during the very first render each card's grid column hasn't finished
    // settling yet, so different cards picked up different bogus widths.
    const previewW = 220, previewH = 120;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, previewW / previewH, 0.1, 20);
    // Every card shares this same close-in framing, tuned for structures
    // roughly bench/garden/fountain-sized — a structure much bigger than
    // that (currently just the Beach) needs the camera pulled back
    // proportionally (`previewCameraScale`) or its own edges run past the
    // frame and past the ground disc below.
    const camScale = model.previewCameraScale || 1;
    camera.position.set(1.6 * camScale, 1.3 * camScale, 1.85 * camScale);
    camera.lookAt(0, 0.3, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(previewW, previewH, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    holder.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xBFE07A, 0.9);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d0, 1.0);
    sun.position.set(2.4, 4, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    scene.add(sun);

    // `previewGroundRadius` is an explicit world-space size, independent of
    // camScale — it just needs to be bigger than the structure's own real
    // extent so the ground still reaches out past its edges (and, for the
    // Beach, past its soft sand fade) instead of running off the disc into
    // the card's plain white background. Defaults to 1.05 (unchanged) for
    // every structure that doesn't override it.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(model.previewGroundRadius || 1.05, 32),
      new THREE.MeshStandardMaterial({ color: 0x6FCB6F, roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const group = (model.previewBuild || model.build)();
    group.traverse((obj) => { if (obj.isMesh) obj.castShadow = true; });
    scene.add(group);

    structurePreviewScenes.push({ renderer, scene, camera, group });
  });

  let t = 0;
  function animate() {
    structureShopAnimId = requestAnimationFrame(animate);
    t += 0.008;
    structurePreviewScenes.forEach((p) => {
      p.group.rotation.y = t;
      p.renderer.render(p.scene, p.camera);
    });
  }
  animate();
}

// A structure can only ever be bought once — after it's placed (confirmed
// in state.village, not just staged in state.placement), it's done for good.
// Garden Patch is the one exception (see REPEATABLE_STRUCTURE_IDS): it never
// reports as purchased, so the shop always lets you buy another.
function isStructurePurchased(id) {
  if (REPEATABLE_STRUCTURE_IDS.has(id)) return false;
  return state.village.some(v => v.type === id);
}

function screenStructureShop() {
  const selected = STRUCTURES.find(s => s.id === state.selectedStructureId);
  // Stable sort (JS arrays sort stably) — purchased ones sink to the
  // bottom, but keep their original relative order, same as the unpurchased.
  const ordered = [...STRUCTURES].sort((a, b) => isStructurePurchased(a.id) - isStructurePurchased(b.id));
  return `
    <div class="screen">
      <div class="txt" style="font-size:15px;">Add to ${escapeHtml(state.villageName)}</div>
      <div class="txt soft tiny">You have 🪙 ${coinsLabel()}</div>
      <div class="grid2">
        ${ordered.map(s => {
          const purchased = isStructurePurchased(s.id);
          return `
            <div class="card structure-card ${purchased ? 'purchased' : ''} ${!purchased && state.selectedStructureId === s.id ? 'selected' : ''}"
                 ${purchased ? '' : `onclick="selectStructure('${s.id}')"`}>
              <div class="structure-preview" data-structure-canvas="${s.id}"></div>
              <div class="txt tiny">${s.name}</div>
              <div class="txt soft tiny">${purchased ? 'Purchased' : `${s.cost} 🪙`}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="spacer"></div>
      <button class="btn" ${!selected ? 'disabled' : ''} onclick="placeStructure()">${selected ? `Place ${selected.name}` : 'Select a structure'}</button>
      ${renderNavbar('structureShop')}
    </div>
  `;
}

function selectStructure(id) {
  const s = STRUCTURES.find(x => x.id === id);
  if (!s || isStructurePurchased(id)) return;
  if (!canAfford(s.cost)) {
    alert(`You need ${s.cost} 🪙 for a ${s.name}.`);
    return;
  }
  state.selectedStructureId = id;
  saveState();
  render();
}

// "Place" doesn't drop the structure immediately — it hands off to the
// Village screen in placement mode, where the player drags a footprint
// ghost around the grid and confirms the exact cell themselves (see
// confirmPlacement/cancelPlacement). Coins aren't spent until confirmed.
function placeStructure() {
  const s = STRUCTURES.find(x => x.id === state.selectedStructureId);
  if (!s || !canAfford(s.cost) || isStructurePurchased(s.id)) return;
  const model = STRUCTURE_MODELS[s.id];
  const spawnPoint = getVillageSpawnPoint();
  const occupancy = layoutVillageBoard(spawnPoint.col, spawnPoint.row).occupancy;
  const spot = model.coastalOnly
    ? findFreeCoastalSpot(occupancy, model.w, model.h)
    : findFreeGridSpot(occupancy, model.w, model.h);
  if (!spot) {
    alert(model.coastalOnly
      ? `There's no room left on the coastline for a ${s.name}.`
      : `There's no room left in the town for a ${s.name}.`);
    return;
  }
  state.placement = { structureId: s.id, col: spot.col, row: spot.row, valid: true };
  state.selectedStructureId = null;
  goTo('village');
}

// ---------- Town Hall interior ----------

// Plays a brief full-frame fade with a label over the whole phone frame —
// used for both entering and leaving the town hall so the screen swap
// underneath (instant, since everything here is procedural geometry, not a
// real asset load) still reads as "going through a doorway" instead of an
// abrupt cut. Appended straight to .phone, a sibling of #app, so it survives
// render()'s innerHTML wipe of #app partway through the transition.
function playScreenTransition(label, onSwitch) {
  const phone = document.querySelector('.phone');
  if (!phone) { onSwitch(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'screen-transition';
  overlay.innerHTML = `
    <div class="screen-transition-dots"><span></span><span></span><span></span></div>
    <div class="screen-transition-label">${escapeHtml(label)}</div>
  `;
  phone.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  setTimeout(() => {
    onSwitch();
    requestAnimationFrame(() => overlay.classList.remove('in'));
    setTimeout(() => overlay.remove(), 400);
  }, 700);
}

function enterTownHall() {
  if (!nearbyTownHallDoor || state.placement || activeDialogue || avatarSitting || avatarSitTarget) return;
  playScreenTransition('Entering Town Hall…', () => goTo('townHallInterior'));
}

function exitTownHall() {
  if (!nearbyHallExit) return;
  playScreenTransition('Leaving Town Hall…', () => goBack());
}

// Room footprint — deliberately roomier than the outside model's own
// stylized 2.4x2.0 footprint, same "bigger on the inside" convention most
// low-poly town sims use, since the real footprint isn't big enough to
// actually walk around in. Z+ is the entrance (south, the same side the
// player just walked through outside), Z- is the far/north wall behind the
// dais. Bumped up from the original 6.6x9.0 at the user's request ("make it
// a bit bigger").
const HALL_ROOM_W = 8.0;
const HALL_ROOM_D = 10.5;
const HALL_HALF_W = HALL_ROOM_W / 2;
const HALL_HALF_D = HALL_ROOM_D / 2;
const HALL_WALL_H = 3.6;
const HALL_DOOR_W = 1.7;
const HALL_WALL_T = 0.24;

// The back office — a smaller room behind the main hall, reached through a
// door in the main hall's own back (north) wall, off to one side rather
// than centered (a real side-office door next to the podium, not competing
// with the seal/flags which stay centered as the room's main focal point).
// `OFFICE_DOOR_X` anchors both the gap in the partition wall and the
// office's own room, so the two always line up automatically.
const OFFICE_DOOR_W = 1.3;
const OFFICE_DOOR_X = 2.4;
const OFFICE_HALF_W = 1.8;
const OFFICE_D = 3.6;
const OFFICE_MIN_X = OFFICE_DOOR_X - OFFICE_HALF_W;
const OFFICE_MAX_X = OFFICE_DOOR_X + OFFICE_HALF_W;
const OFFICE_FAR_Z = -HALL_HALF_D - OFFICE_D;

// The door leaf and its frame, module-level so the geometry that draws them
// and openOfficeDoor()'s swung-open collider can't drift apart (they did
// once already, when the panel width was hardcoded in two places). The
// jambs sit centered on the gap's own edges, so the *clear* opening between
// their inner faces — and therefore the panel that has to fill it — is one
// frame-thickness narrower than the gap, and the hinge sits half a frame
// thickness in from the gap edge. Sized this way, a closed door exactly
// fills its frame with no slit down the latch side.
const OFFICE_DOOR_FRAME_T = 0.08;
const OFFICE_DOOR_H = 2.0;
const OFFICE_DOOR_PANEL_W = OFFICE_DOOR_W - OFFICE_DOOR_FRAME_T;
const OFFICE_DOOR_HINGE_X = OFFICE_DOOR_X - OFFICE_DOOR_W / 2 + OFFICE_DOOR_FRAME_T / 2;

// A close, steep-tilt follow camera — same fixed-tilt/never-rotates
// convention as the village's own camera (VILLAGE_CAM_*), just scaled down
// to frame a small room instead of the whole board.
const HALL_CAM_HEIGHT = 4.4;
const HALL_CAM_BACK = 3.1;
const HALL_CAM_LOOK_HEIGHT = 0.6;
// The camera offset is now genuinely fixed — it always sits exactly
// HALL_CAM_BACK behind and HALL_CAM_HEIGHT above the avatar, so the view
// angle never changes no matter where in the building you stand.
//
// It used to be clamped in z (to stop it ending up on the far side of a
// wall from the avatar, staring at blank plaster). That clamp moved the
// camera's z *without* its height, which doesn't shorten the shot — it
// tilts it, and badly: measured live, the pitch swung 81°→51° just walking
// in from the entrance, and inside the office the clamp put the camera
// *in front of* the avatar (looking backwards at him) and then exactly
// on top of him — an 89° singularity. That was the "extremely wonky"
// camera.
//
// Walls are handled where the problem actually is instead: whichever wall
// comes between the camera and the avatar is simply not drawn that frame
// (see the cutaway block in animate()). Because the camera always looks
// north, only two walls can ever be in the way, and each one's toggle
// point lands exactly where it's already either behind the camera or
// fully blocking the shot — so nothing visibly pops.
function hallCamZFor(avatarZ) {
  return avatarZ + HALL_CAM_BACK;
}

function makeHallFloorTexture() {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#E8DCC8';
    ctx.fillRect(0, 0, w, h);
    const tiles = 8, step = w / tiles;
    ctx.fillStyle = '#DBC9A3';
    for (let r = 0; r < tiles; r++) {
      for (let c = 0; c < tiles; c++) {
        if ((r + c) % 2 === 0) ctx.fillRect(c * step, r * step, step, step);
      }
    }
  });
}

// The gold-on-blue civic seal mounted on the back wall behind the podium —
// same trim blue / gold accent colors as the outside model, so it reads as
// this town hall's own emblem rather than a generic decoration.
function makeSealTexture() {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = '#2C6CA6';
    ctx.beginPath(); ctx.arc(cx, cy, 118, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#FFC93C';
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(cx, cy, 106, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 82, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#FFC93C';
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / 5);
      const a2 = a + Math.PI / 5;
      ctx.lineTo(cx + Math.cos(a) * 50, cy + Math.sin(a) * 50);
      ctx.lineTo(cx + Math.cos(a2) * 21, cy + Math.sin(a2) * 21);
    }
    ctx.closePath();
    ctx.fill();
  });
}

// A cork board of pinned notices by the entrance — a small dose of "this is
// a working civic building," not just a throne room.
function makeNoticeBoardTexture() {
  return makeCanvasTexture(200, 140, (ctx, w, h) => {
    ctx.fillStyle = '#C9975B';
    ctx.fillRect(0, 0, w, h);
    const notes = [
      { x: 18, y: 14, w: 60, h: 42, c: '#FFF6E4' },
      { x: 96, y: 20, w: 56, h: 38, c: '#FFE3A8' },
      { x: 30, y: 70, w: 66, h: 44, c: '#EAF3E0' },
      { x: 118, y: 66, w: 54, h: 46, c: '#FFDDE0' },
    ];
    notes.forEach((n) => {
      ctx.fillStyle = n.c;
      ctx.fillRect(n.x, n.y, n.w, n.h);
      ctx.strokeStyle = '#00000022';
      ctx.lineWidth = 1;
      ctx.strokeRect(n.x, n.y, n.w, n.h);
      ctx.fillStyle = '#00000030';
      for (let i = 0; i < 3; i++) ctx.fillRect(n.x + 6, n.y + 8 + i * 9, n.w - 14, 3);
    });
  });
}

// A small wall placard beside the office doorway, mounted on the main
// hall's own side so a player can tell what the door leads to before
// walking through it.
function makeOfficePlacardTexture() {
  return makeCanvasTexture(200, 90, (ctx, w, h) => {
    ctx.fillStyle = '#2C6CA6';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#FFC93C';
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.font = 'bold 26px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFF6E4';
    ctx.fillText('OFFICE', w / 2, h / 2 + 1);
  });
}

// A row of colorful book spines for the office bookshelf — flat painted
// detail on a plane, same technique as every other small-scale texture in
// this file, rather than modeling dozens of individual book meshes.
function makeBookshelfTexture() {
  return makeCanvasTexture(200, 220, (ctx, w, h) => {
    ctx.fillStyle = '#5A3B22';
    ctx.fillRect(0, 0, w, h);
    const shelfColors = ['#C23B4E', '#3D8FD6', '#4CAF6D', '#E8A93C', '#8B5FBF', '#D9584C'];
    const rows = 3;
    const rowH = h / rows;
    for (let r = 0; r < rows; r++) {
      ctx.fillStyle = '#2C1E12';
      ctx.fillRect(0, r * rowH + rowH - 10, w, 10);
      let x = 6;
      let i = 0;
      while (x < w - 6) {
        const bw = 12 + ((r * 7 + i * 5) % 14);
        ctx.fillStyle = shelfColors[(r + i) % shelfColors.length];
        ctx.fillRect(x, r * rowH + 6, bw, rowH - 20);
        x += bw + 3;
        i++;
      }
    }
  });
}

// The town hall's furnished interior — a civic hall in the same palette as
// the outside model (cream walls, warm red flags, blue trim, gold flourishes
// — see makeTownHall()), built as one static group. Deliberately no ceiling
// mesh: the follow camera sits above HALL_WALL_H looking down at a steep
// angle (see HALL_CAM_*), same as every outdoor building's own roof is only
// ever seen from outside/above — a ceiling here would just block the view
// of the room it's supposed to cover.
//
// Returns `{ group, colliders }` rather than just a group — every wall
// segment and piece of furniture pushes its own collision box onto
// `colliders` right where it's built, so the visual geometry and the
// walkable-space geometry can never drift apart the way two separately
// hand-maintained lists could.
function buildTownHallInterior() {
  const g = new THREE.Group();
  const colliders = [];
  const wallBox = (cx, cz, hw, hh) => colliders.push({ x: cx, z: cz, hw, hh });
  // Standable surfaces (the stairs' treads and the dais top), registered
  // right where their meshes are built so the two can't drift apart —
  // same single-source-of-truth reasoning as `colliders`/wallBox above.
  // hallGroundHeightAt() samples these to lift the avatar onto them.
  const platforms = [];
  const standOn = (minX, maxX, minZ, maxZ, height) => platforms.push({ minX, maxX, minZ, maxZ, height });
  // The only two walls that can ever come between the camera and the
  // avatar (the camera always looks north, so the side/far walls never
  // can). Grouped so animate() can hide whichever one is currently in the
  // way — everything mounted on each wall plane goes in with it, since a
  // decal floating in mid-air after its wall is cut away would look worse
  // than the occlusion did. Their colliders are registered as normal:
  // this is a *visual* cutaway, the walls stay solid to walk into.
  const southWall = new THREE.Group();
  const partitionWall = new THREE.Group();
  g.add(southWall);
  g.add(partitionWall);
  const wall = 0xFFF6E4, trim = 0x2C6CA6, wood = 0xC9975B, woodDark = 0x8B5E34, gold = 0xFFC93C, roofRed = 0xD9584C;

  // Hoisted up from the dais/podium section below (which still builds the
  // actual dais mesh in place) since the rug's own length needs to know
  // exactly where the steps up to the dais begin, to stop short of them.
  const DAIS_H = 0.4;
  const daisZ = -HALL_HALF_D + 1.15;
  // +Z is south (toward the entrance) in this room, so the dais's own
  // *front* (entrance-facing) edge is at daisZ + half its depth, not
  // minus — an earlier pass had this backwards, which quietly built the
  // steps against the dais's *back* edge instead (right behind the
  // podium, next to the seal) rather than the front, i.e. on the
  // opposite side from the aisle a real approaching player would use.
  // That's the real reason "there are still no stairs": they existed,
  // colored correctly, just facing the wrong way — no screenshot ever
  // caught it because every close-up test happened to be framed from
  // behind the podium already. Found only by raycasting into the scene
  // and reading back exactly which mesh was rendering where, not by
  // eyeballing another angle.
  const daisFrontZ = daisZ + 0.75;
  const STEP_DEPTH = 0.28;
  const STEP_W = 2.8;

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(HALL_ROOM_W, 0.12, HALL_ROOM_D),
    new THREE.MeshStandardMaterial({ map: makeHallFloorTexture(), roughness: 0.9 })
  );
  floor.position.y = -0.06;
  floor.receiveShadow = true;
  g.add(floor);

  const officeFloor = new THREE.Mesh(
    new THREE.BoxGeometry(OFFICE_HALF_W * 2, 0.12, OFFICE_D),
    new THREE.MeshStandardMaterial({ map: makeHallFloorTexture(), roughness: 0.9 })
  );
  officeFloor.position.set(OFFICE_DOOR_X, -0.06, OFFICE_FAR_Z + OFFICE_D / 2);
  officeFloor.receiveShadow = true;
  g.add(officeFloor);

  // An apron of floor continuing south past the entrance wall. Only ever
  // seen when that wall is cut away (camera outside it, near the
  // entrance) — without it the bottom of the frame there is raw
  // background, since the room's own floor stops dead at the wall. Its
  // own texture repeat is set to match the room floor's check size
  // exactly rather than stretching one copy across a different-sized
  // slab, so the seam doesn't read as two different floors.
  const apronD = 3.75, apronW = 12;
  const apronTex = makeHallFloorTexture();
  apronTex.wrapS = apronTex.wrapT = THREE.RepeatWrapping;
  apronTex.repeat.set(apronW / HALL_ROOM_W, apronD / HALL_ROOM_D);
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(apronW, 0.12, apronD),
    new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.9 })
  );
  apron.position.set(0, -0.06, HALL_HALF_D + apronD / 2);
  apron.receiveShadow = true;
  g.add(apron);

  // A center aisle rug (blue field, gold stripe) leading from the door up
  // to the base of the steps — stops exactly there (not running under the
  // steps themselves the way a length-from-the-room-depth guess used to)
  // so the flat rug plane can't z-fight with the steps' own geometry where
  // the two would otherwise overlap.
  const rugNorthZ = daisFrontZ + STEP_DEPTH * 2;
  const rugSouthZ = HALL_HALF_D - 0.9;
  const rugLen = rugSouthZ - rugNorthZ;
  const rugCenterZ = (rugSouthZ + rugNorthZ) / 2;
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, rugLen),
    new THREE.MeshStandardMaterial({ color: trim, roughness: 0.95 })
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.005, rugCenterZ);
  rug.receiveShadow = true;
  g.add(rug);
  const rugStripe = new THREE.Mesh(
    new THREE.PlaneGeometry(1.05, rugLen),
    new THREE.MeshStandardMaterial({ color: gold, roughness: 0.95 })
  );
  rugStripe.rotation.x = -Math.PI / 2;
  rugStripe.position.set(0, 0.008, rugCenterZ);
  g.add(rugStripe);

  // Walls — four perimeter walls, the south one split into two jambs to
  // leave a HALL_DOOR_W-wide doorway open for the player to walk through
  // (no real geometric hole/CSG — just two segments with a gap between
  // them, the same trick every simpler model in this file already uses for
  // doors and windows).
  const wallMat = new THREE.MeshStandardMaterial({ color: wall, roughness: 0.88 });
  const trimMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.7 });

  // Back (north) wall is now a partition, not a dead end — split into two
  // segments around OFFICE_DOOR_X/OFFICE_DOOR_W to leave a doorway into the
  // office, same "two segments, no real CSG hole" trick as the south
  // entrance. The wide west segment carries the seal/podium/flags (all
  // still centered at x=0, untouched); the office door sits to the east of
  // them so it doesn't compete with that centerpiece.
  const officeGapMinX = OFFICE_DOOR_X - OFFICE_DOOR_W / 2;
  const officeGapMaxX = OFFICE_DOOR_X + OFFICE_DOOR_W / 2;
  [{ from: -HALL_HALF_W, to: officeGapMinX }, { from: officeGapMaxX, to: HALL_HALF_W }].forEach(({ from, to }) => {
    const segW = to - from;
    const cx = (from + to) / 2;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(segW, HALL_WALL_H, HALL_WALL_T), wallMat);
    seg.position.set(cx, HALL_WALL_H / 2, -HALL_HALF_D);
    seg.receiveShadow = true;
    partitionWall.add(seg);
    wallBox(cx, -HALL_HALF_D, segW / 2, HALL_WALL_T / 2);
  });
  // Wall above the doorway. The two partition segments above leave their
  // gap open for the wall's *full* height, so without this there's a
  // 1.4-unit slot above the door you can see straight through into the
  // office over — the header trim alone only covered y 2.0–2.2. A real
  // doorway is a hole in a wall, not a slot to the ceiling.
  const officeDoorHeaderH = HALL_WALL_H - (OFFICE_DOOR_H + 0.2);
  const officeDoorHeader = new THREE.Mesh(
    new THREE.BoxGeometry(OFFICE_DOOR_W, officeDoorHeaderH, HALL_WALL_T),
    wallMat
  );
  officeDoorHeader.position.set(OFFICE_DOOR_X, OFFICE_DOOR_H + 0.2 + officeDoorHeaderH / 2, -HALL_HALF_D);
  officeDoorHeader.receiveShadow = true;
  partitionWall.add(officeDoorHeader);

  // A real door frame/casing — a header band sitting right on top of the
  // door panel plus two vertical side jambs running its full height, all
  // the way down to the floor, rather than the door just standing in a
  // bare hole in the wall with an unconnected trim strip floating up near
  // the ceiling (an earlier version's header sat at y≈3.15, a full unit
  // above the 2.0-tall door — the user: "why is there no door frame?!").
  const officeDoorTrimTop = new THREE.Mesh(
    new THREE.BoxGeometry(OFFICE_DOOR_W + OFFICE_DOOR_FRAME_T * 2, 0.2, HALL_WALL_T + 0.02),
    trimMat
  );
  officeDoorTrimTop.position.set(OFFICE_DOOR_X, OFFICE_DOOR_H + 0.1, -HALL_HALF_D);
  partitionWall.add(officeDoorTrimTop);
  [officeGapMinX, officeGapMaxX].forEach((x) => {
    const jambTrim = new THREE.Mesh(
      new THREE.BoxGeometry(OFFICE_DOOR_FRAME_T, OFFICE_DOOR_H, HALL_WALL_T + 0.02),
      trimMat
    );
    jambTrim.position.set(x, OFFICE_DOOR_H / 2, -HALL_HALF_D);
    partitionWall.add(jambTrim);
  });
  // A small placard beside the doorway, mounted on the main hall's own
  // side (the wall's south-facing surface, same default-orientation plane
  // as the seal/back-windows below), so a player can tell what the door
  // leads to before walking through it.
  const placard = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.25), new THREE.MeshBasicMaterial({ map: makeOfficePlacardTexture() }));
  placard.position.set(officeGapMinX - 0.4, 1.5, -HALL_HALF_D + HALL_WALL_T / 2 + 0.01);
  partitionWall.add(placard);

  // A door leaf for the office — hinged at the west jamb, closed by
  // default (sealing the doorway, like a real door) until the player
  // opens it via a proximity "Open" button — see nearbyOfficeDoor /
  // openOfficeDoor() / hallOfficeDoorOpenAmount in
  // initTownHallInteriorScene(), which eases officeDoorPivot's own
  // rotation from closed (0) to open (90°, swung into the office) once
  // triggered. Pivoted around a Group at the hinge point (not the panel's
  // own center) so that rotation swings it like an actual door instead of
  // spinning in place.
  const officeDoorPivot = new THREE.Group();
  officeDoorPivot.position.set(OFFICE_DOOR_HINGE_X, 0, -HALL_HALF_D);
  officeDoorPivot.rotation.y = 0; // closed — panel lies flat across the doorway gap
  const officeDoorPanel = new THREE.Mesh(
    new THREE.BoxGeometry(OFFICE_DOOR_PANEL_W, OFFICE_DOOR_H, 0.05),
    new THREE.MeshStandardMaterial({ color: woodDark, roughness: 0.65 })
  );
  officeDoorPanel.position.set(OFFICE_DOOR_PANEL_W / 2, OFFICE_DOOR_H / 2, 0);
  officeDoorPanel.castShadow = true;
  officeDoorPivot.add(officeDoorPanel);
  const officeDoorKnob = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 8, 8),
    new THREE.MeshStandardMaterial({ color: gold, roughness: 0.4, metalness: 0.5 })
  );
  officeDoorKnob.position.set(OFFICE_DOOR_PANEL_W - 0.1, 0.95, 0.045);
  officeDoorPivot.add(officeDoorKnob);
  partitionWall.add(officeDoorPivot);
  // Closed-state collider: seals the whole doorway gap, same as any other
  // solid wall segment. `openOfficeDoor()` mutates this exact object's own
  // x/z/hw/hh in place (rather than swapping array entries, so nothing
  // else holding a reference to it goes stale) to the thin footprint of
  // the swung-open panel once the player opens it.
  const officeDoorCollider = { x: OFFICE_DOOR_X, z: -HALL_HALF_D, hw: OFFICE_DOOR_W / 2, hh: HALL_WALL_T / 2 + 0.02 };
  colliders.push(officeDoorCollider);

  const jambW = (HALL_ROOM_W - HALL_DOOR_W) / 2;
  [-1, 1].forEach((side) => {
    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(HALL_WALL_T, HALL_WALL_H, HALL_ROOM_D), wallMat);
    sideWall.position.set(side * HALL_HALF_W, HALL_WALL_H / 2, 0);
    sideWall.receiveShadow = true;
    g.add(sideWall);
    wallBox(side * HALL_HALF_W, 0, HALL_WALL_T / 2, HALL_ROOM_D / 2);

    const jamb = new THREE.Mesh(new THREE.BoxGeometry(jambW, HALL_WALL_H, HALL_WALL_T), wallMat);
    jamb.position.set(side * (HALL_DOOR_W / 2 + jambW / 2), HALL_WALL_H / 2, HALL_HALF_D);
    jamb.receiveShadow = true;
    southWall.add(jamb);
    wallBox(side * (HALL_DOOR_W / 2 + jambW / 2), HALL_HALF_D, jambW / 2, HALL_WALL_T / 2);

    // A low wainscoting band, same trim blue as the outside doors, tying
    // the interior back to the exterior's palette.
    const band = new THREE.Mesh(new THREE.BoxGeometry(HALL_WALL_T + 0.02, 0.5, HALL_ROOM_D), trimMat);
    band.position.set(side * HALL_HALF_W, 0.28, 0);
    g.add(band);

    // A window set into each side wall, angled to face into the room —
    // PlaneGeometry's default normal is +z, so it's rotated -90°/+90°
    // around Y (east/west respectively) to point inward rather than out
    // through the wall, where it'd be backface-culled and invisible.
    const winTex = makeWindowTexture('#ffffff', '#BEE7FB');
    [-3.4, -0.6, 2.4].forEach((z) => {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 1.3), new THREE.MeshBasicMaterial({ map: winTex }));
      win.position.set(side * (HALL_HALF_W - HALL_WALL_T / 2 - 0.01), 1.9, z);
      win.rotation.y = -side * Math.PI / 2;
      g.add(win);
    });
  });
  const doorTrimTop = new THREE.Mesh(new THREE.BoxGeometry(HALL_DOOR_W + 0.3, 0.22, HALL_WALL_T), trimMat);
  doorTrimTop.position.set(0, HALL_WALL_H - 0.5, HALL_HALF_D);
  southWall.add(doorTrimTop);

  // One clerestory window beside the seal on the west portion of the back
  // wall — that wall's interior face points +z, straight back at the
  // camera, so (unlike the side walls above) it needs no extra rotation.
  // Only one now (not a symmetric pair) since the office doorway takes up
  // the space the east-side window used to sit in.
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.0), new THREE.MeshBasicMaterial({ map: makeWindowTexture('#ffffff', '#BEE7FB') }));
  win.position.set(-1.9, 2.6, -HALL_HALF_D + HALL_WALL_T / 2 + 0.01);
  partitionWall.add(win);

  // The room's visual anchor: a civic seal on the back wall, centered
  // above the podium.
  const seal = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), new THREE.MeshBasicMaterial({ map: makeSealTexture() }));
  seal.position.set(0, 2.05, -HALL_HALF_D + HALL_WALL_T / 2 + 0.01);
  partitionWall.add(seal);

  // Raised dais + podium + two flags — the same flag/gold-trim flourish
  // makeTownHall() uses outside, so the interior reads as the same
  // building rather than a generic room. Taller than the original pass
  // (0.26→DAIS_H=0.4) at the user's request ("further up"), and now a
  // genuinely solid block — see the collider right below — rather than a
  // walkable-through platform with only the small podium collider on it.
  const dais = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, DAIS_H, 1.5),
    new THREE.MeshStandardMaterial({ color: trim, roughness: 0.75 })
  );
  dais.position.set(0, DAIS_H / 2, daisZ);
  dais.castShadow = true;
  dais.receiveShadow = true;
  g.add(dais);
  // Two solid side-blocks flank the stairs, rather than one collider
  // covering the platform's full width — leaves exactly the STEP_W-wide
  // lane the steps themselves occupy open, so the avatar can actually
  // walk up through it onto the platform. The platform's own left/right
  // edges stay solid, same as any other furniture; the podium gets its
  // own small collider back below, since the platform is reachable now
  // rather than sealed off entirely behind one big block.
  const daisSideHW = (3.6 / 2 - STEP_W / 2) / 2;
  const daisSideCX = STEP_W / 2 + daisSideHW;
  [-1, 1].forEach((side) => wallBox(side * daisSideCX, daisZ, daisSideHW, 0.75));
  // ...and the back edge, which the side blocks don't cover. Without this
  // the open stair lane runs clean off the *back* of the platform: the
  // avatar walked north past z=-4.85, his ground height dropped 0.4 back
  // to the floor, and he ended up wedged in the sliver between the dais
  // and the north wall with the platform clipping through him — only the
  // wall stopped him, not the platform. Sits just behind the back face so
  // the avatar's own radius brings him flush to the edge and no further.
  wallBox(0, daisZ - 0.75 - 0.05, 1.8, 0.05);
  // ...and the platform's own top surface is registered as standable
  // ground, so the avatar rides up onto it rather than walking through it
  // at floor level with the dais buried through his shins. See
  // hallGroundHeightAt()/the ground-follow block in animate().
  standOn(-1.8, 1.8, daisZ - 0.75, daisZ + 0.75, DAIS_H);

  // Small steps up to the dais, on its aisle-facing (south) side. No
  // blocking collider on these — they're what the avatar walks *up*, via
  // the standOn() registrations below that lift him tread by tread onto
  // the platform, rather than something to bump into. Wood-toned treads
  // with a gold nosing edge on each. Two fixes deep now: the first version
  // used the same `trim` blue as the dais/rug it sits between and blended
  // in completely; wood fixed the color, but at the original 1.3-wide
  // footprint the steps still sat almost entirely hidden directly behind
  // the podium (0.85 tall vs. the steps' own 0.2-0.4) — a steep top-down
  // camera foreshortens a tall nearby object forward over whatever's
  // right behind it, confirmed by moving the camera off to the side and
  // only then catching a sliver of tread color. Widened to 2.8 (most of
  // the dais's own 3.6, but still short of its edges) so plenty of each
  // step extends past the podium's own narrow silhouette from dead ahead,
  // not just from an off-angle view — the user: "there are still no
  // stairs," and a color/width fix alone wouldn't have caught this: traced
  // with a raycast (not another screenshot guess) to find the upper
  // step's own back face sitting on the *exact* same z-plane as the
  // dais's front face, both spanning the same y-range — genuine z-fighting
  // between two coincident opaque surfaces, won inconsistently by
  // whichever one happened to render second, reading as "the dais's blue
  // just continues right through where the step should be." Each step's
  // geometry now extends STEP_EMBED further back than its front (nosing)
  // edge, so its back face sits safely behind the surface it's flush
  // against instead of exactly on top of it — same embedding idea as the
  // podium-touching-the-dais fix earlier in this same session.
  const STEP_EMBED = 0.02;
  const treadMat = new THREE.MeshStandardMaterial({ color: wood, roughness: 0.75 });
  const nosingMat = new THREE.MeshStandardMaterial({ color: gold, roughness: 0.5, metalness: 0.2 });
  [{ cy: DAIS_H - 0.1, cz: daisFrontZ + STEP_DEPTH / 2 }, { cy: DAIS_H - 0.3, cz: daisFrontZ + STEP_DEPTH * 1.5 }].forEach(({ cy, cz }) => {
    const step = new THREE.Mesh(new THREE.BoxGeometry(STEP_W, 0.2, STEP_DEPTH + STEP_EMBED), treadMat);
    step.position.set(0, cy, cz - STEP_EMBED / 2);
    step.castShadow = true;
    step.receiveShadow = true;
    g.add(step);
    const nosing = new THREE.Mesh(new THREE.BoxGeometry(STEP_W + 0.02, 0.04, 0.04), nosingMat);
    nosing.position.set(0, cy + 0.1 + 0.02, cz + STEP_DEPTH / 2);
    g.add(nosing);
    // Each tread's own top surface is standable ground (its center height
    // plus half its 0.2 thickness), so walking up the stairs actually
    // lifts the avatar tread by tread — 0 → 0.2 → 0.4 — onto the dais,
    // instead of him sliding through solid-looking steps at floor level.
    standOn(-STEP_W / 2, STEP_W / 2, cz - STEP_DEPTH / 2 - STEP_EMBED, cz + STEP_DEPTH / 2, cy + 0.1);
  });

  // Podium sits toward the *front* of the platform — measured back from
  // the dais's own front edge rather than forward from the wall, so it
  // stays put relative to the edge it's supposed to be near. It used to
  // sit at -HALL_HALF_D + 0.75, tucked right up against the back wall
  // under the seal; forward of center reads much more like a real stage
  // (speaker at the front facing the room) and, counterintuitively, also
  // *opens up* the standing space behind it rather than squeezing it.
  // One constant for both the mesh and its collider — this file has
  // already been bitten twice by the same position written out twice.
  const podiumZ = daisFrontZ - 0.55;
  const podiumGroup = new THREE.Group();
  const podiumBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.85, 0.4),
    new THREE.MeshStandardMaterial({ color: woodDark, roughness: 0.75 })
  );
  // Local y is now half its own height, i.e. its bottom sits at local y=0
  // — combined with podiumGroup's own position.y below (set to DAIS_H, the
  // dais's exact top surface), the podium's base lands flush on the dais
  // with no gap. The old version had podiumBody's bottom at local y=0.255
  // while podiumGroup sat at a fixed 0.26, leaving it floating about a
  // quarter-unit above the dais — the user's "make the podium actually
  // touch the ground" complaint, verified against the actual numbers
  // rather than just re-eyeballing a screenshot.
  podiumBody.position.y = 0.425;
  podiumBody.rotation.x = -0.08;
  podiumBody.castShadow = true;
  podiumGroup.add(podiumBody);
  const podiumTop = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.05, 0.46),
    new THREE.MeshStandardMaterial({ color: wood, roughness: 0.7 })
  );
  podiumTop.position.y = 0.835;
  podiumGroup.add(podiumTop);
  podiumGroup.position.set(0, DAIS_H, podiumZ);
  g.add(podiumGroup);
  wallBox(0, podiumZ, 0.35, 0.25);

  [-1, 1].forEach((side) => {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 2.1, 8),
      new THREE.MeshStandardMaterial({ color: woodDark })
    );
    pole.position.set(side * 1.35, DAIS_H + 1.05, -HALL_HALF_D + 0.5);
    g.add(pole);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.3),
      new THREE.MeshStandardMaterial({ color: side < 0 ? roofRed : trim, side: THREE.DoubleSide, roughness: 0.8 })
    );
    flag.position.set(side * 1.35 + side * 0.21, DAIS_H + 1.85, -HALL_HALF_D + 0.5);
    g.add(flag);
  });

  // Pew-style bench rows flanking the center aisle, facing the podium —
  // reusing the exact same builder as the outdoor Bench structure so the
  // low-poly language matches, just reoriented. `makeBench()`'s backrest
  // sits on its local -Z side (see the outdoor version), so a sitter faces
  // local +Z; a 180° turn points that straight at the podium (world -Z)
  // rather than out to the side. (Previously rotated ±90° instead, which
  // pointed the benches' fronts at the side walls they sat against — the
  // bug the user flagged.)
  [-1, 1].forEach((x) => {
    [2.7, 0.9].forEach((z) => {
      const bench = makeBench();
      bench.rotation.y = Math.PI;
      bench.position.set(x * 1.75, 0, z);
      g.add(bench);
      // Collider swapped hw/hh from the old side-wall orientation — the
      // bench's long axis (half-length ~0.8) now runs along X, not Z.
      wallBox(x * 1.75, z, 0.82, 0.2);
    });
  });

  // Frame mounted flush against the wall, board plane in front of its own
  // frame (not the other way around — an earlier version had the frame's
  // front face sitting closer to the room than the board plane, which
  // z-fought and hid the notice texture behind the frame's own wood).
  const wallInnerX = -(HALL_HALF_W - HALL_WALL_T / 2);
  const boardFrame = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.52, 0.72),
    new THREE.MeshStandardMaterial({ color: woodDark, roughness: 0.8 })
  );
  boardFrame.position.set(wallInnerX + 0.025, 1.5, HALL_HALF_D - 1.6);
  g.add(boardFrame);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.42), new THREE.MeshBasicMaterial({ map: makeNoticeBoardTexture() }));
  board.position.set(wallInnerX + 0.055, 1.5, HALL_HALF_D - 1.6);
  board.rotation.y = Math.PI / 2;
  g.add(board);

  // A small hanging chandelier — floats at a fixed height with no visible
  // ceiling to hang it from (see the note above on why this room has none),
  // which reads fine from the same steep top-down camera angle everything
  // else in the village uses.
  const chandelier = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.035, 8, 20),
    new THREE.MeshStandardMaterial({ color: gold, roughness: 0.4, metalness: 0.5 })
  );
  ring.rotation.x = Math.PI / 2;
  chandelier.add(ring);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const candle = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xFFE9B0, emissive: 0xFFC060, emissiveIntensity: 0.9, roughness: 0.5 })
    );
    candle.position.set(Math.cos(a) * 0.42, 0.04, Math.sin(a) * 0.42);
    chandelier.add(candle);
  }
  const chain = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6),
    new THREE.MeshStandardMaterial({ color: woodDark })
  );
  chain.position.y = 0.45;
  chandelier.add(chain);
  chandelier.position.set(0, HALL_WALL_H - 0.55, 0.4);
  g.add(chandelier);
  const chandLight = new THREE.PointLight(0xFFD79A, 0.9, 6.5, 2);
  chandLight.position.copy(chandelier.position);
  g.add(chandLight);

  // ---- The back office — a smaller room through the placard-marked
  // doorway above, past the podium. Same wall material as the main hall so
  // it reads as part of the same building, simpler furnishing than the
  // hall proper (a working desk, not a second civic centerpiece).
  const officeCenterZ = OFFICE_FAR_Z + OFFICE_D / 2;
  [OFFICE_MIN_X, OFFICE_MAX_X].forEach((x) => {
    const officeSideWall = new THREE.Mesh(new THREE.BoxGeometry(HALL_WALL_T, HALL_WALL_H, OFFICE_D), wallMat);
    officeSideWall.position.set(x, HALL_WALL_H / 2, officeCenterZ);
    officeSideWall.receiveShadow = true;
    g.add(officeSideWall);
    wallBox(x, officeCenterZ, HALL_WALL_T / 2, OFFICE_D / 2);
  });
  const officeBack = new THREE.Mesh(new THREE.BoxGeometry(OFFICE_HALF_W * 2, HALL_WALL_H, HALL_WALL_T), wallMat);
  officeBack.position.set(OFFICE_DOOR_X, HALL_WALL_H / 2, OFFICE_FAR_Z);
  officeBack.receiveShadow = true;
  g.add(officeBack);
  wallBox(OFFICE_DOOR_X, OFFICE_FAR_Z, OFFICE_HALF_W, HALL_WALL_T / 2);

  const officeWin = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.85), new THREE.MeshBasicMaterial({ map: makeWindowTexture('#ffffff', '#BEE7FB') }));
  officeWin.position.set(OFFICE_MAX_X - 0.55, 1.9, OFFICE_FAR_Z + HALL_WALL_T / 2 + 0.01);
  g.add(officeWin);

  // Desk, facing the doorway so a visitor sees its front on the way in — a
  // solid cabinet-style body plus a slightly overhanging top rather than a
  // legged table, simpler to build and reads fine at this scale.
  const deskZ = OFFICE_FAR_Z + 1.15;
  const deskBody = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.5, 0.6),
    new THREE.MeshStandardMaterial({ color: woodDark, roughness: 0.75 })
  );
  deskBody.position.set(OFFICE_DOOR_X, 0.25, deskZ);
  deskBody.castShadow = true;
  deskBody.receiveShadow = true;
  g.add(deskBody);
  const deskTop = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.05, 0.68),
    new THREE.MeshStandardMaterial({ color: wood, roughness: 0.65 })
  );
  deskTop.position.set(OFFICE_DOOR_X, 0.525, deskZ);
  g.add(deskTop);
  wallBox(OFFICE_DOOR_X, deskZ, 0.7, 0.34);

  // A small desk lamp — an emissive shade rather than a real added light,
  // enough detail to read as "someone works here" without another PointLight.
  const lampBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.06, 0.04, 10),
    new THREE.MeshStandardMaterial({ color: woodDark })
  );
  lampBase.position.set(OFFICE_DOOR_X + 0.45, 0.57, deskZ - 0.12);
  g.add(lampBase);
  const lampShade = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.12, 10, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xFFE9B0, emissive: 0xFFC060, emissiveIntensity: 0.6, side: THREE.DoubleSide })
  );
  lampShade.position.set(OFFICE_DOOR_X + 0.45, 0.7, deskZ - 0.12);
  g.add(lampShade);

  // Chair behind the desk, facing the doorway (south) — its own small
  // seat/backrest on thin legs, distinct from makeBench()'s proportions.
  const chairZ = OFFICE_FAR_Z + 0.5;
  const chairMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.8 });
  const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.38), chairMat);
  chairSeat.position.set(OFFICE_DOOR_X, 0.42, chairZ);
  g.add(chairSeat);
  const chairBack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.38, 0.06), chairMat);
  chairBack.position.set(OFFICE_DOOR_X, 0.63, chairZ - 0.16);
  g.add(chairBack);
  [-1, 1].forEach((side) => {
    [-1, 1].forEach((fb) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 6), new THREE.MeshStandardMaterial({ color: woodDark }));
      leg.position.set(OFFICE_DOOR_X + side * 0.16, 0.21, chairZ + fb * 0.15);
      g.add(leg);
    });
  });

  // Bookshelf against the office's west wall — a solid body plus a
  // painted-spines front plane, same flat-detail-on-a-plane technique as
  // every other small-scale texture in this file rather than modeling
  // dozens of individual books.
  const shelfX = OFFICE_MIN_X + HALL_WALL_T / 2 + 0.14;
  const shelfZ = OFFICE_FAR_Z + 1.9;
  const shelfBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 1.5, 1.1),
    new THREE.MeshStandardMaterial({ color: woodDark, roughness: 0.8 })
  );
  shelfBody.position.set(shelfX, 0.75, shelfZ);
  shelfBody.castShadow = true;
  g.add(shelfBody);
  const shelfFront = new THREE.Mesh(
    new THREE.PlaneGeometry(1.08, 1.42),
    new THREE.MeshBasicMaterial({ map: makeBookshelfTexture() })
  );
  shelfFront.position.set(shelfX + 0.145, 0.75, shelfZ);
  shelfFront.rotation.y = Math.PI / 2;
  g.add(shelfFront);
  wallBox(shelfX, shelfZ, 0.14, 0.55);

  // Cutaway walls fade rather than blink. The south wall's toggle happens
  // exactly as the camera crosses its plane, so it'd be imperceptible
  // either way — but the partition's is driven by the *avatar* crossing
  // the doorway while the camera is still 3.1 back, so a hard toggle
  // would visibly pop the wall out from under the player mid-stride.
  // Materials are cloned per mesh first: the wall/trim materials are
  // shared with the side walls and everything else in the room, so fading
  // them in place would fade half the building with them.
  [southWall, partitionWall].forEach((group) => {
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.transparent = true;
    });
  });

  return { group: g, colliders, platforms, officeDoorPivot, officeDoorCollider, southWall, partitionWall };
}

let hallScene = null, hallCamera = null, hallRenderer = null;
let hallAnimId = null, hallClock = null;
let hallAvatarRoot = null, hallColliders = [];
// Standable surfaces (stair treads, the dais top) and the avatar's current
// eased ground height. There's no jump or real elevation system in this
// game, but walking up something the player can see is raised should still
// put them *on* it rather than through it — see hallGroundHeightAt().
let hallPlatforms = [], hallAvatarGroundY = 0;
// The two cutaway wall groups — faded out for any frame they'd sit between
// the camera and the avatar. See the cutaway block in animate().
let hallSouthWall = null, hallPartitionWall = null;
let hallSouthWallFade = 1, hallPartitionFade = 1;

// Applies a cutaway group's current fade (1 = solid, 0 = fully cut away),
// dropping it out of rendering entirely once it's effectively invisible.
function setHallWallFade(group, amount) {
  if (!group) return;
  group.visible = amount > 0.02;
  group.traverse((o) => { if (o.isMesh) o.material.opacity = amount; });
}
let hallJoystickBase = null, hallJoystickHandlers = null;
// The office door: `hallOfficeDoorPivot` is the THREE.Group animate() eases
// open (rotation 0→Math.PI/2 as `hallOfficeDoorOpenAmount` rises 0→1);
// `hallOfficeDoorCollider` is the exact collider object buildTownHallInterior()
// pushed onto hallColliders for it — openOfficeDoor() mutates its own
// x/z/hw/hh in place from "seals the whole gap" to "thin swung-open panel"
// rather than swapping array entries. `nearbyOfficeDoor` gates the "Open"
// button the same way nearbyTownHallDoor gates the outside "Enter" one.
let hallOfficeDoorPivot = null, hallOfficeDoorCollider = null;
let hallOfficeDoorOpen = false, hallOfficeDoorOpenAmount = 0;
// Which side of the doorway the avatar was on the moment the door was
// opened ('south' = main hall, 'north' = office) — animate() watches for
// the avatar clearing HALL_OFFICE_DOOR_CLOSE_MARGIN past the *other* side
// and auto-closes the instant that happens, a real self-closing door
// rather than one that just stays open forever after the first use.
let hallOfficeDoorOpenSide = null;
let nearbyOfficeDoor = false;
// The south entrance "Exit" prompt — proximity-gated the same way the
// village's own "Enter" button is (see ENTER_RADIUS), rather than a
// button that's simply always on screen.
let nearbyHallExit = false;

// Simple box-only collision push-out — the hall only ever has a handful of
// static box obstacles (the podium, the two benches), so this doesn't need
// resolveVillageCollisions()'s circle-vs-box generality, and deliberately
// doesn't touch that function or its module-level villageColliders closure.
// Height of the standable ground under a given x/z — the tallest platform
// whose footprint contains the point (stair treads overlap the dais's own
// footprint slightly, so "tallest wins" is what keeps that seam smooth),
// or 0 for the plain floor.
function hallGroundHeightAt(x, z) {
  let h = 0;
  hallPlatforms.forEach((p) => {
    if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && p.height > h) h = p.height;
  });
  return h;
}

function resolveHallCollisions(pos, radius) {
  hallColliders.forEach((c) => {
    const closestX = Math.max(c.x - c.hw, Math.min(pos.x, c.x + c.hw));
    const closestZ = Math.max(c.z - c.hh, Math.min(pos.z, c.z + c.hh));
    const dx = pos.x - closestX, dz = pos.z - closestZ;
    const d = Math.hypot(dx, dz);
    if (d < radius && d > 0.0001) {
      const push = radius - d;
      pos.x += (dx / d) * push;
      pos.z += (dz / d) * push;
    }
  });
  return pos;
}

function teardownTownHallInteriorScene() {
  if (hallAnimId !== null) cancelAnimationFrame(hallAnimId);
  hallAnimId = null;
  if (hallRenderer) {
    hallRenderer.dispose();
    if (hallRenderer.forceContextLoss) hallRenderer.forceContextLoss();
    hallRenderer = null;
  }
  if (hallJoystickBase && hallJoystickHandlers) {
    hallJoystickBase.removeEventListener('pointerdown', hallJoystickHandlers.down);
    hallJoystickBase.removeEventListener('pointermove', hallJoystickHandlers.move);
    hallJoystickBase.removeEventListener('pointerup', hallJoystickHandlers.up);
    hallJoystickBase.removeEventListener('pointercancel', hallJoystickHandlers.up);
    hallJoystickBase.removeEventListener('lostpointercapture', hallJoystickHandlers.up);
    window.removeEventListener('pointerup', hallJoystickHandlers.up);
    window.removeEventListener('pointercancel', hallJoystickHandlers.up);
    window.removeEventListener('blur', hallJoystickHandlers.reset);
  }
  hallJoystickBase = null;
  hallJoystickHandlers = null;
  hallScene = null;
  hallCamera = null;
  hallAvatarRoot = null;
  hallColliders = [];
  hallPlatforms = [];
  hallAvatarGroundY = 0;
  hallSouthWall = null;
  hallPartitionWall = null;
  hallSouthWallFade = 1;
  hallPartitionFade = 1;
  hallOfficeDoorPivot = null;
  hallOfficeDoorCollider = null;
  hallOfficeDoorOpen = false;
  hallOfficeDoorOpenAmount = 0;
  hallOfficeDoorOpenSide = null;
  nearbyOfficeDoor = false;
  nearbyHallExit = false;
}

// How far past the *opposite* side of the doorway the avatar needs to walk
// before the door auto-closes behind them — see the check in animate().
// Generous enough (well past the closed collider's own 0.14 half-depth)
// that reactivating the closed collider the instant this trips can never
// land on top of the avatar and shove it.
const HALL_OFFICE_DOOR_CLOSE_MARGIN = 0.5;

// Opens the office door — only once the "Open" button (itself only shown
// within ENTER_RADIUS of the door, see animate()) is tapped. Sets the flag
// animate() eases officeDoorPivot's rotation toward, and immediately swaps
// the door's collider from "seals the whole gap" to the thin swung-open-
// panel footprint so the doorway is walkable right away rather than
// waiting for the swing animation to visually finish. Also records which
// side the avatar opened it from, so animate() knows which direction
// counts as "walked all the way through" for the auto-close below.
function openOfficeDoor() {
  if (!nearbyOfficeDoor || hallOfficeDoorOpen || !hallOfficeDoorCollider || !hallAvatarRoot) return;
  hallOfficeDoorOpen = true;
  hallOfficeDoorOpenSide = hallAvatarRoot.position.z > -HALL_HALF_D ? 'south' : 'north';
  hallOfficeDoorCollider.x = OFFICE_DOOR_HINGE_X;
  hallOfficeDoorCollider.z = -HALL_HALF_D - OFFICE_DOOR_PANEL_W / 2;
  hallOfficeDoorCollider.hw = 0.05;
  hallOfficeDoorCollider.hh = OFFICE_DOOR_PANEL_W / 2;
}

// Closes the office door — called automatically by animate() once the
// avatar has walked all the way through to the other side (see
// HALL_OFFICE_DOOR_CLOSE_MARGIN), a real self-closing door rather than one
// that just stays open forever after the first use. Restores the collider
// to its original "seals the whole gap" dimensions; officeDoorPivot's own
// rotation eases back to 0 on its own in animate() as hallOfficeDoorOpenAmount
// follows hallOfficeDoorOpen back down, same easing as opening.
function closeOfficeDoor() {
  hallOfficeDoorOpen = false;
  hallOfficeDoorOpenSide = null;
  if (!hallOfficeDoorCollider) return;
  hallOfficeDoorCollider.x = OFFICE_DOOR_X;
  hallOfficeDoorCollider.z = -HALL_HALF_D;
  hallOfficeDoorCollider.hw = OFFICE_DOOR_W / 2;
  hallOfficeDoorCollider.hh = HALL_WALL_T / 2 + 0.02;
}

function initTownHallInteriorScene() {
  teardownTownHallInteriorScene();
  const holder = document.getElementById('townHallScene');
  if (!holder || typeof THREE === 'undefined') return;

  hallScene = new THREE.Scene();
  hallScene.background = new THREE.Color(0x3A2E22);

  hallCamera = new THREE.PerspectiveCamera(50, holder.clientWidth / holder.clientHeight, 0.1, 60);

  hallRenderer = new THREE.WebGLRenderer({ antialias: true });
  hallRenderer.setSize(holder.clientWidth, holder.clientHeight);
  hallRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  hallRenderer.shadowMap.enabled = true;
  hallRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  hallRenderer.toneMapping = THREE.LinearToneMapping;
  hallRenderer.toneMappingExposure = 0.9;
  holder.appendChild(hallRenderer.domElement);

  const hemi = new THREE.HemisphereLight(0xFFF3D8, 0x6B4A2E, 0.7);
  hallScene.add(hemi);
  const sun = new THREE.DirectionalLight(0xFFEBC4, 0.7);
  sun.position.set(3, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -5;
  sun.shadow.camera.right = 5;
  sun.shadow.camera.top = 5;
  sun.shadow.camera.bottom = -5;
  hallScene.add(sun);

  const built = buildTownHallInterior();
  hallScene.add(built.group);
  hallColliders = built.colliders;
  hallPlatforms = built.platforms;
  hallSouthWall = built.southWall;
  hallPartitionWall = built.partitionWall;
  hallOfficeDoorPivot = built.officeDoorPivot;
  hallOfficeDoorCollider = built.officeDoorCollider;

  hallAvatarRoot = new THREE.Group();
  const avatarModel = new THREE.Group();
  const avatarCharacter = buildCharacter(state.character);
  avatarModel.add(avatarCharacter);
  avatarModel.scale.setScalar(VILLAGE_MODEL_SCALE);
  avatarModel.position.y = -(GROUND_Y + FOOT_MARGIN) * VILLAGE_MODEL_SCALE;
  hallAvatarRoot.add(avatarModel);
  const spawnZ = HALL_HALF_D - 0.9;
  hallAvatarRoot.position.set(0, 0, spawnZ);
  hallAvatarRoot.rotation.y = Math.PI;
  hallScene.add(hallAvatarRoot);

  hallCamera.position.set(0, HALL_CAM_HEIGHT, hallCamZFor(spawnZ));
  hallCamera.lookAt(0, HALL_CAM_LOOK_HEIGHT, spawnZ);

  hallClock = new THREE.Clock();

  const JOYSTICK_MAX = 40;
  const joystickVec = { x: 0, z: 0 };
  hallJoystickBase = document.getElementById('hallJoystickBase');
  const joystickKnob = document.getElementById('hallJoystickKnob');
  let joystickPointerId = null;

  function updateJoystickFromEvent(e) {
    const rect = hallJoystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_MAX) {
      dx = (dx / dist) * JOYSTICK_MAX;
      dy = (dy / dist) * JOYSTICK_MAX;
    }
    joystickVec.x = dx / JOYSTICK_MAX;
    joystickVec.z = dy / JOYSTICK_MAX;
    joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  function resetJoystick() {
    joystickPointerId = null;
    joystickVec.x = 0;
    joystickVec.z = 0;
    joystickKnob.style.transform = 'translate(0px, 0px)';
  }
  const onJoystickDown = (e) => {
    joystickPointerId = e.pointerId;
    // See the same try/catch in the village screen's own joystick.
    try { hallJoystickBase.setPointerCapture(e.pointerId); } catch (err) {}
    updateJoystickFromEvent(e);
  };
  const onJoystickMove = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    // See the same check in the village screen's own joystick — some
    // browsers occasionally drop the up/cancel event for a captured
    // pointer, leaving the joystick stuck "on" until touched again;
    // `buttons === 0` here means it's no longer actually pressed even
    // though we were never told, so treat it as a release.
    if (e.buttons === 0) { resetJoystick(); return; }
    updateJoystickFromEvent(e);
  };
  const onJoystickUp = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    resetJoystick();
  };
  if (hallJoystickBase) {
    hallJoystickHandlers = { down: onJoystickDown, move: onJoystickMove, up: onJoystickUp, reset: resetJoystick };
    hallJoystickBase.addEventListener('pointerdown', onJoystickDown);
    hallJoystickBase.addEventListener('pointermove', onJoystickMove);
    hallJoystickBase.addEventListener('pointerup', onJoystickUp);
    hallJoystickBase.addEventListener('pointercancel', onJoystickUp);
    hallJoystickBase.addEventListener('lostpointercapture', onJoystickUp);
    window.addEventListener('pointerup', onJoystickUp);
    window.addEventListener('pointercancel', onJoystickUp);
    window.addEventListener('blur', resetJoystick);
  }

  let walkPhase = 0;
  let walkAmount = 0;

  function animate() {
    hallAnimId = requestAnimationFrame(animate);
    const dt = Math.min(hallClock.getDelta(), 0.05);

    const mag = Math.min(1, Math.hypot(joystickVec.x, joystickVec.z));
    const pushed = mag > 0.08;
    if (pushed) {
      const invMag = 1 / (Math.hypot(joystickVec.x, joystickVec.z) || 1);
      const dirX = joystickVec.x * invMag;
      const dirZ = joystickVec.z * invMag;
      const pos = hallAvatarRoot.position;
      const step = AVATAR_SPEED * mag * dt;
      pos.x += dirX * step;
      pos.z += dirZ * step;
      // A loose outer safety clamp, not a tight room boundary — now that
      // there are two rooms (an L-shaped combined footprint, not a single
      // rectangle), the real walls are what actually contain the avatar
      // (see the wall colliders `buildTownHallInterior()` returns, resolved
      // just below); this just stops it from ever flying off into the void
      // through a geometry mistake, sized to the union of both rooms.
      const margin = AVATAR_RADIUS + 0.15;
      pos.x = Math.max(Math.min(-HALL_HALF_W, OFFICE_MIN_X) + margin, Math.min(Math.max(HALL_HALF_W, OFFICE_MAX_X) - margin, pos.x));
      pos.z = Math.max(OFFICE_FAR_Z + margin, Math.min(HALL_HALF_D - margin, pos.z));
      resolveHallCollisions(pos, AVATAR_RADIUS);
      const targetAngle = Math.atan2(dirX, dirZ);
      hallAvatarRoot.rotation.y = smoothAngle(hallAvatarRoot.rotation.y, targetAngle, dt);
    }

    if (pushed) walkPhase += dt * 9;
    walkAmount += ((pushed ? 1 : 0) - walkAmount) * Math.min(1, dt * 10);
    poseWalkCycle(avatarCharacter, walkPhase, walkAmount);

    // Ride up onto whatever standable surface is underfoot (stair treads,
    // the dais). Eased rather than snapped so a step up reads as a stride
    // rather than a teleport, and applied to the root — avatarModel's own
    // y already holds the fixed feet-on-ground offset, same convention the
    // village's sit-lift uses.
    const followPos = hallAvatarRoot.position;
    const targetGroundY = hallGroundHeightAt(followPos.x, followPos.z);
    hallAvatarGroundY += (targetGroundY - hallAvatarGroundY) * Math.min(1, dt * 12);
    hallAvatarRoot.position.y = hallAvatarGroundY;

    // The camera rises with him, so standing on the dais keeps the exact
    // same framing as standing on the floor instead of letting him sink
    // toward the bottom of the shot.
    const desiredCamPos = { x: followPos.x, y: HALL_CAM_HEIGHT + hallAvatarGroundY, z: hallCamZFor(followPos.z) };
    const camLerp = 1 - Math.pow(0.001, dt);
    hallCamera.position.x += (desiredCamPos.x - hallCamera.position.x) * camLerp;
    hallCamera.position.y += (desiredCamPos.y - hallCamera.position.y) * camLerp;
    hallCamera.position.z += (desiredCamPos.z - hallCamera.position.z) * camLerp;
    hallCamera.lookAt(followPos.x, HALL_CAM_LOOK_HEIGHT + hallAvatarGroundY, followPos.z);

    // Wall cutaway: hide whichever wall currently sits between the camera
    // and the avatar, so the fixed camera offset above never has to
    // contort itself to dodge one. Each test uses the camera's *actual*
    // z, so the toggle lands exactly where the wall stops being behind
    // the camera and starts blocking the shot — at that instant it's
    // invisible either way, so there's no pop. Purely visual: the wall
    // colliders are untouched and still solid.
    const camZ = hallCamera.position.z;
    const southBlocking = camZ > HALL_HALF_D && followPos.z < HALL_HALF_D;
    const partitionBlocking = camZ > -HALL_HALF_D && followPos.z < -HALL_HALF_D;
    hallSouthWallFade += ((southBlocking ? 0 : 1) - hallSouthWallFade) * Math.min(1, dt * 8);
    hallPartitionFade += ((partitionBlocking ? 0 : 1) - hallPartitionFade) * Math.min(1, dt * 8);
    setHallWallFade(hallSouthWall, hallSouthWallFade);
    setHallWallFade(hallPartitionWall, hallPartitionFade);

    // The office door's own "Open" prompt — same proximity pattern as the
    // outside "Enter" button (see ENTER_RADIUS), gated off once already
    // open since there's nothing left to press.
    nearbyOfficeDoor = !hallOfficeDoorOpen && Math.hypot(OFFICE_DOOR_X - followPos.x, -HALL_HALF_D - followPos.z) < ENTER_RADIUS;
    const officeOpenBtn = document.getElementById('hallOfficeOpenBtn');
    if (officeOpenBtn) officeOpenBtn.style.display = nearbyOfficeDoor ? '' : 'none';
    hallOfficeDoorOpenAmount += ((hallOfficeDoorOpen ? 1 : 0) - hallOfficeDoorOpenAmount) * Math.min(1, dt * 6);
    if (hallOfficeDoorPivot) hallOfficeDoorPivot.rotation.y = hallOfficeDoorOpenAmount * (Math.PI / 2);

    // Self-closing: the instant the avatar has walked all the way through
    // to the side *opposite* the one it opened the door from, close it
    // again — a real self-closing door, not one that just stays open
    // forever after the first use. Getting back out (from either side)
    // just means the same proximity "Open" prompt shows again.
    if (hallOfficeDoorOpen && hallOfficeDoorOpenSide) {
      const pastNorth = hallOfficeDoorOpenSide === 'south' && followPos.z < -HALL_HALF_D - HALL_OFFICE_DOOR_CLOSE_MARGIN;
      const pastSouth = hallOfficeDoorOpenSide === 'north' && followPos.z > -HALL_HALF_D + HALL_OFFICE_DOOR_CLOSE_MARGIN;
      if (pastNorth || pastSouth) closeOfficeDoor();
    }

    // The south entrance's own "Exit" prompt — proximity-gated the same
    // way, rather than a button that's just always on screen.
    nearbyHallExit = Math.hypot(0 - followPos.x, HALL_HALF_D - followPos.z) < ENTER_RADIUS;
    const exitBtn = document.getElementById('hallExitBtn');
    if (exitBtn) exitBtn.style.display = nearbyHallExit ? '' : 'none';

    hallRenderer.render(hallScene, hallCamera);
  }
  animate();
}

function screenTownHallInterior() {
  return `
    <div class="screen village-screen">
      <div class="village-plot" style="position:relative; padding:0;">
        <div id="townHallScene" style="position:absolute; inset:0;"></div>
        <div class="village-overlay-top">
          <div class="chip-row">
            <span class="chip on">Town Hall</span>
          </div>
        </div>
        <div class="joystick-base" id="hallJoystickBase">
          <div class="joystick-knob" id="hallJoystickKnob"></div>
        </div>
        <div class="village-action-row">
          <button class="talk-btn" id="hallOfficeOpenBtn" style="display:none;" onclick="openOfficeDoor()">Open</button>
          <button class="talk-btn" id="hallExitBtn" style="display:none;" onclick="exitTownHall()">Exit</button>
        </div>
      </div>
      ${renderNavbar('village')}
    </div>
  `;
}

// ---------- Party Hall interior ----------
//
// Deliberately built as its own module rather than sharing infrastructure
// with the Town Hall interior — same reasoning as when that one was built:
// the two rooms' furnishings and palettes have almost nothing in common
// (civic cream and oak vs. a dark neon club), so a shared builder would
// fight the content more than it would save. What IS reused is the *shape*
// of the module: own scene/camera/renderer globals, own box collision
// resolver, `standOn()` platforms for raised surfaces, a genuinely fixed
// follow camera with a wall cutaway for occlusion, and playScreenTransition()
// on the way in and out.

// The party hall is a purchasable structure, so unlike the town hall it may
// not exist yet — every entry point here has to cope with that.
function getPartyHall() {
  return (state.village || []).find((s) => s.type === 'party-hall') || null;
}

// The party hall's own front-door threshold in world space, or null if the
// town doesn't have one. Its doors are modeled on the +Z face (see
// makePartyHall), and +Z is south here as everywhere else, so the threshold
// sits just outside the south edge of its placed collider — the collider's
// own half-depth scaled by STRUCTURE_MAP_SCALE, exactly like the structure
// itself is when placed.
function getPartyHallDoorPoint() {
  const s = getPartyHall();
  if (!s || s.col === undefined || s.row === undefined) return null;
  const model = STRUCTURE_MODELS['party-hall'];
  const c = footprintCenterWorld(s.col, s.row, model.w, model.h);
  return { x: c.x, z: c.z + model.collide.hh * STRUCTURE_MAP_SCALE };
}

function enterPartyHall() {
  if (!nearbyPartyHallDoor || state.placement || activeDialogue || avatarSitting || avatarSitTarget) return;
  playScreenTransition('Entering the Party Hall…', () => goTo('partyHallInterior'));
}

function exitPartyHall() {
  if (!nearbyPartyExit) return;
  playScreenTransition('Leaving the Party Hall…', () => goBack());
}

// Room footprint — same "bigger on the inside" convention as the town hall
// (the outdoor model's own footprint is far too small to walk around in).
// +Z is south, the side the player just walked in from; -Z is the far end,
// where the stage is.
const PARTY_ROOM_W = 8.4;
const PARTY_ROOM_D = 11.0;
const PARTY_HALF_W = PARTY_ROOM_W / 2;
const PARTY_HALF_D = PARTY_ROOM_D / 2;
const PARTY_WALL_H = 3.6;
const PARTY_DOOR_W = 1.8;
const PARTY_WALL_T = 0.24;

// The stage at the far end, and the steps up onto it. The steps run south
// (toward the entrance) from the stage's own front edge — note that "front"
// here means the LARGER z, since +Z is south; getting that sign backwards
// is what once built the town hall's steps against the wrong edge, so it's
// spelled out rather than left to intuition.
const STAGE_H = 0.45;
const STAGE_HALF_W = 2.6;
const STAGE_HALF_D = 1.5;
const STAGE_Z = -PARTY_HALF_D + STAGE_HALF_D;
const STAGE_FRONT_Z = STAGE_Z + STAGE_HALF_D;
const STEP_DEPTH = 0.3;
const STEP_HALF_W = 1.0;
const STEP_COUNT = 3;

// A close, steep-tilt follow camera. Same fixed-offset rule the town hall
// arrived at the hard way: the offset is NEVER clamped on a single axis,
// because moving the camera's z without its height doesn't shorten the shot,
// it tilts it — that produced a 30-degree swing just from walking across the
// room, and a near-singularity where the camera sat on top of the avatar.
// Occlusion is solved where the problem actually is, by not drawing the wall
// that's in the way (see the cutaway in animate()).
const PARTY_CAM_HEIGHT = 4.4;
const PARTY_CAM_BACK = 3.1;
const PARTY_CAM_LOOK_HEIGHT = 0.6;
function partyCamZFor(avatarZ) {
  return avatarZ + PARTY_CAM_BACK;
}

// Club palette, carried over from the outside model (see makePartyHall) so
// the inside reads as the same building: deep purple walls, hot pink neon,
// near-black gloss, and gold for the marquee lights.
const PARTY_WALL_C = 0x3B1A52;
const PARTY_DARK_C = 0x1C1620;
const PARTY_NEON_C = 0xFF3FB0;
const PARTY_CYAN_C = 0x35E0E8;
const PARTY_GOLD_C = 0xFFC93C;

function makePartyFloorTexture() {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#241033';
    ctx.fillRect(0, 0, w, h);
    // A faint darker check, just enough to give the floor a scale reference
    // underfoot without competing with the lit dance floor in the middle.
    ctx.fillStyle = '#2C1440';
    const tiles = 8, step = w / tiles;
    for (let r = 0; r < tiles; r++) {
      for (let c = 0; c < tiles; c++) {
        if ((r + c) % 2 === 0) ctx.fillRect(c * step, r * step, step, step);
      }
    }
  });
}

// One lit dance-floor panel. Drawn rather than lit for real: these are
// MeshBasicMaterial so they read as emissive without needing a light per
// panel, and animate() cycles their colors.
function makeDancePanelTexture() {
  return makeCanvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, w, h);
  });
}

function makeBarFrontTexture() {
  return makeCanvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#2A1338';
    ctx.fillRect(0, 0, w, h);
    // Vertical neon ribs along the bar front — the same trick the outside
    // model uses for its under-roofline strip, just repeated.
    ctx.fillStyle = '#FF3FB0';
    for (let x = 16; x < w; x += 32) ctx.fillRect(x, h * 0.25, 5, h * 0.6);
    ctx.fillStyle = 'rgba(255,63,176,0.25)';
    ctx.fillRect(0, h * 0.16, w, 6);
  });
}

// Builds the whole room and returns its geometry alongside the colliders and
// standable surfaces it generated, rather than keeping a second hand-written
// list somewhere else that could silently drift out of sync with what's
// actually on screen. Same contract as buildTownHallInterior().
function buildPartyHallInterior() {
  const g = new THREE.Group();
  const colliders = [];
  const wallBox = (cx, cz, hw, hh) => colliders.push({ x: cx, z: cz, hw, hh });
  const platforms = [];
  const standOn = (minX, maxX, minZ, maxZ, height) => platforms.push({ minX, maxX, minZ, maxZ, height });
  // Everything mounted on the entrance wall goes in this group so the
  // cutaway in animate() can drop it all at once — a neon strip left
  // floating in mid-air after its wall vanished would look worse than the
  // occlusion it was solving.
  const southWall = new THREE.Group();
  g.add(southWall);

  const wallMat = new THREE.MeshStandardMaterial({ color: PARTY_WALL_C, roughness: 0.85 });
  const darkMat = new THREE.MeshStandardMaterial({ color: PARTY_DARK_C, roughness: 0.35, metalness: 0.2 });
  const neonMat = new THREE.MeshBasicMaterial({ color: PARTY_NEON_C });
  const cyanMat = new THREE.MeshBasicMaterial({ color: PARTY_CYAN_C });
  const goldMat = new THREE.MeshStandardMaterial({ color: PARTY_GOLD_C, roughness: 0.4, metalness: 0.5 });

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(PARTY_ROOM_W, 0.12, PARTY_ROOM_D),
    new THREE.MeshStandardMaterial({ map: makePartyFloorTexture(), roughness: 0.8 })
  );
  floor.position.y = -0.06;
  floor.receiveShadow = true;
  g.add(floor);

  // An apron of floor continuing south past the entrance wall — only ever
  // seen when that wall is cut away, but without it the bottom of the frame
  // there is raw background. Same fix the town hall needed.
  const apronD = 3.75;
  const apronTex = makePartyFloorTexture();
  apronTex.wrapS = apronTex.wrapT = THREE.RepeatWrapping;
  apronTex.repeat.set(12 / PARTY_ROOM_W, apronD / PARTY_ROOM_D);
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(12, 0.12, apronD),
    new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.8 })
  );
  apron.position.set(0, -0.06, PARTY_HALF_D + apronD / 2);
  apron.receiveShadow = true;
  g.add(apron);

  // ---- walls ----
  // Each wall segment registers its own collider as it is built.
  function addWall(cx, cz, w, d, parent) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, PARTY_WALL_H, d), wallMat);
    m.position.set(cx, PARTY_WALL_H / 2, cz);
    m.receiveShadow = true;
    (parent || g).add(m);
    wallBox(cx, cz, w / 2, d / 2);
    return m;
  }
  addWall(0, -PARTY_HALF_D, PARTY_ROOM_W, PARTY_WALL_T);                       // far wall, behind the stage
  addWall(-PARTY_HALF_W, 0, PARTY_WALL_T, PARTY_ROOM_D);                        // west
  addWall(PARTY_HALF_W, 0, PARTY_WALL_T, PARTY_ROOM_D);                         // east
  // South wall, split into two jambs around the entrance gap — the same
  // faked opening every other door and window in this file uses.
  const jambW = (PARTY_ROOM_W - PARTY_DOOR_W) / 2;
  addWall(-(PARTY_DOOR_W / 2 + jambW / 2), PARTY_HALF_D, jambW, PARTY_WALL_T, southWall);
  addWall(PARTY_DOOR_W / 2 + jambW / 2, PARTY_HALF_D, jambW, PARTY_WALL_T, southWall);

  // Neon strips running along the top of every wall, and down the entrance
  // jambs — the club's main source of visual identity, and the reason the
  // room reads as purple-lit rather than just dark.
  function neonStrip(cx, cy, cz, w, d, mat, parent) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, d), mat);
    m.position.set(cx, cy, cz);
    (parent || g).add(m);
    return m;
  }
  neonStrip(0, PARTY_WALL_H - 0.35, -PARTY_HALF_D + 0.14, PARTY_ROOM_W, 0.06, neonMat);
  neonStrip(-PARTY_HALF_W + 0.14, PARTY_WALL_H - 0.35, 0, 0.06, PARTY_ROOM_D, cyanMat);
  neonStrip(PARTY_HALF_W - 0.14, PARTY_WALL_H - 0.35, 0, 0.06, PARTY_ROOM_D, cyanMat);
  [-1, 1].forEach((side) => {
    neonStrip(side * (PARTY_DOOR_W / 2 + jambW / 2), PARTY_WALL_H - 0.35,
      PARTY_HALF_D - 0.14, jambW, 0.06, neonMat, southWall);
  });

  // ---- dance floor ----
  // A grid of lit panels in the middle of the room. They're their own
  // meshes (not one texture) so animate() can cycle each panel's color
  // independently, which is what makes the floor read as *running* rather
  // than as a static painted rectangle.
  const DANCE_COLS = 5, DANCE_ROWS = 5, DANCE_TILE = 0.78;
  const danceZ = 0.9;
  const dancePanels = [];
  const danceTex = makeDancePanelTexture();
  for (let r = 0; r < DANCE_ROWS; r++) {
    for (let c = 0; c < DANCE_COLS; c++) {
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(DANCE_TILE, DANCE_TILE),
        new THREE.MeshBasicMaterial({ map: danceTex, transparent: true, opacity: 0.9 })
      );
      panel.rotation.x = -Math.PI / 2;
      panel.position.set(
        (c - (DANCE_COLS - 1) / 2) * DANCE_TILE,
        0.011,
        danceZ + (r - (DANCE_ROWS - 1) / 2) * DANCE_TILE
      );
      g.add(panel);
      dancePanels.push(panel);
    }
  }

  // ---- stage ----
  const stage = new THREE.Mesh(
    new THREE.BoxGeometry(STAGE_HALF_W * 2, STAGE_H, STAGE_HALF_D * 2),
    new THREE.MeshStandardMaterial({ color: 0x46215E, roughness: 0.7 })
  );
  stage.position.set(0, STAGE_H / 2, STAGE_Z);
  stage.castShadow = true;
  stage.receiveShadow = true;
  g.add(stage);
  standOn(-STAGE_HALF_W, STAGE_HALF_W, STAGE_Z - STAGE_HALF_D, STAGE_FRONT_Z, STAGE_H);
  // The stage is a walkable PLATFORM, so what it needs is a lip around its
  // edge — not colliders filling its footprint. An earlier pass used two
  // boxes spanning the stage's whole depth, flanking the step lane. They did
  // their intended job (you can only get up the 0.45 drop via the steps),
  // but a collider has no height, so they went on blocking once the player
  // was standing on top: the walkable stage was cut down to the lane's own
  // width, x +-0.74 after the avatar's radius. Since the DJ booth reaches
  // x +-0.95, there was no way around it and the whole back of the stage was
  // sealed off behind what felt like invisible walls.
  //
  // Thin barriers along the front (either side of the lane) and down both
  // sides do the same job without the side effect: they stop you stepping
  // over the edge, and leave the entire stage top free to walk on.
  const STAGE_LIP = 0.12;
  const laneHalf = STEP_HALF_W;
  [-1, 1].forEach((side) => {
    const inner = side * laneHalf, outer = side * STAGE_HALF_W;
    wallBox((inner + outer) / 2, STAGE_FRONT_Z - STAGE_LIP, Math.abs(outer - inner) / 2, STAGE_LIP);
    wallBox(side * (STAGE_HALF_W - STAGE_LIP), STAGE_Z, STAGE_LIP, STAGE_HALF_D);
  });
  // Neon lip along the stage front edge.
  neonStrip(0, STAGE_H - 0.03, STAGE_FRONT_Z - 0.04, STAGE_HALF_W * 2, 0.08, neonMat);

  // Steps down from the stage front toward the entrance. Larger z is south,
  // so each successive step is at a LARGER z and a LOWER height.
  for (let i = 0; i < STEP_COUNT; i++) {
    const h = STAGE_H * (STEP_COUNT - i) / STEP_COUNT;
    const zNear = STAGE_FRONT_Z + i * STEP_DEPTH;
    const zFar = zNear + STEP_DEPTH;
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(STEP_HALF_W * 2, h, STEP_DEPTH),
      new THREE.MeshStandardMaterial({ color: 0x46215E, roughness: 0.7 })
    );
    step.position.set(0, h / 2, (zNear + zFar) / 2);
    step.castShadow = true;
    step.receiveShadow = true;
    g.add(step);
    standOn(-STEP_HALF_W, STEP_HALF_W, zNear, zFar, h);
  }

  // ---- DJ booth on the stage ----
  const boothW = 1.9, boothH = 0.62, boothD = 0.5;
  const boothZ = STAGE_Z - 0.45;
  const booth = new THREE.Mesh(new THREE.BoxGeometry(boothW, boothH, boothD), darkMat);
  booth.position.set(0, STAGE_H + boothH / 2, boothZ);
  booth.castShadow = true;
  g.add(booth);
  wallBox(0, boothZ, boothW / 2, boothD / 2);
  // Lit face panel and a pair of decks on top, so the booth reads as
  // equipment rather than a plain crate.
  neonStrip(0, STAGE_H + boothH - 0.08, boothZ + boothD / 2 + 0.01, boothW - 0.2, 0.05, cyanMat);
  [-1, 1].forEach((side) => {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.36), darkMat);
    deck.position.set(side * 0.45, STAGE_H + boothH + 0.03, boothZ);
    g.add(deck);
    const platter = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 20), goldMat);
    platter.position.set(side * 0.45, STAGE_H + boothH + 0.07, boothZ);
    g.add(platter);
  });

  // The same marquee the outside of the building wears, hung on the back
  // wall above the stage — the one piece that ties inside to outside.
  const marquee = new THREE.Mesh(
    new THREE.PlaneGeometry(3.12, 1.2),
    new THREE.MeshBasicMaterial({ map: makePartyHallSignTexture(), transparent: true })
  );
  marquee.position.set(0, 2.25, -PARTY_HALF_D + PARTY_WALL_T / 2 + 0.02);
  g.add(marquee);

  // ---- speaker stacks flanking the stage ----
  [-1, 1].forEach((side) => {
    const sx = side * 3.35, sz = STAGE_FRONT_Z - 0.5;
    [0, 1].forEach((tier) => {
      const hgt = tier === 0 ? 1.0 : 0.8;
      const yBase = tier === 0 ? 0 : 1.0;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.85, hgt, 0.7), darkMat);
      cab.position.set(sx, yBase + hgt / 2, sz);
      cab.castShadow = true;
      g.add(cab);
      // Cones on the front face.
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.05, 20), goldMat);
      cone.rotation.x = Math.PI / 2;
      cone.position.set(sx, yBase + hgt / 2, sz + 0.37);
      g.add(cone);
    });
    wallBox(sx, sz, 0.45, 0.37);
  });

  // ---- bar along the west wall ----
  const barX = -3.25, barZ = 1.35, barHalfD = 1.85, barHalfW = 0.4, BAR_H = 1.05;
  const barTex = makeBarFrontTexture();
  barTex.wrapS = barTex.wrapT = THREE.RepeatWrapping;
  barTex.repeat.set(barHalfD, 1);
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(barHalfW * 2, BAR_H, barHalfD * 2),
    new THREE.MeshStandardMaterial({ map: barTex, roughness: 0.6 })
  );
  bar.position.set(barX, BAR_H / 2, barZ);
  bar.castShadow = true;
  g.add(bar);
  wallBox(barX, barZ, barHalfW, barHalfD);
  const barTop = new THREE.Mesh(
    new THREE.BoxGeometry(barHalfW * 2 + 0.14, 0.07, barHalfD * 2 + 0.14),
    new THREE.MeshStandardMaterial({ color: 0x120A18, roughness: 0.25, metalness: 0.35 })
  );
  barTop.position.set(barX, BAR_H + 0.035, barZ);
  g.add(barTop);

  // Back-bar shelf against the wall, with bottles.
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.5, barHalfD * 2), darkMat);
  shelf.position.set(-PARTY_HALF_W + 0.24, 0.75, barZ);
  g.add(shelf);
  wallBox(-PARTY_HALF_W + 0.24, barZ, 0.11, barHalfD);
  const bottleColors = [0x35E0E8, 0xFF3FB0, 0xFFC93C, 0x9BE85F, 0xFF8A3D];
  for (let i = 0; i < 10; i++) {
    const bottle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.055, 0.26, 10),
      new THREE.MeshStandardMaterial({
        color: bottleColors[i % bottleColors.length],
        emissive: bottleColors[i % bottleColors.length],
        emissiveIntensity: 0.45,
        roughness: 0.3,
      })
    );
    bottle.position.set(-PARTY_HALF_W + 0.24, 1.63, barZ - barHalfD + 0.25 + i * 0.34);
    g.add(bottle);
  }

  // Stools along the open side of the bar.
  for (let i = 0; i < 3; i++) {
    const sz = barZ - 1.1 + i * 1.1;
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.09, 16), neonMat);
    seat.position.set(-2.5, 0.72, sz);
    g.add(seat);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.68, 10), darkMat);
    post.position.set(-2.5, 0.34, sz);
    g.add(post);
    wallBox(-2.5, sz, 0.2, 0.2);
  }

  // ---- booth seating along the east wall ----
  [-0.4, 2.4].forEach((bz) => {
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.45, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x6E2352, roughness: 0.8 })
    );
    bench.position.set(3.6, 0.225, bz);
    bench.castShadow = true;
    g.add(bench);
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.75, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x6E2352, roughness: 0.8 })
    );
    back.position.set(3.99, 0.6, bz);
    g.add(back);
    wallBox(3.7, bz, 0.5, 0.75);
    // A small round table in front of each booth.
    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.07, 20), darkMat);
    table.position.set(2.72, 0.7, bz);
    table.castShadow = true;
    g.add(table);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.68, 12), darkMat);
    leg.position.set(2.72, 0.34, bz);
    g.add(leg);
    wallBox(2.72, bz, 0.36, 0.36);
  });

  // ---- the hanging rig: disco ball, truss and par cans ----
  // All of it goes in one group so animate() can fade the lot together. It
  // hangs directly over the walking route up the middle of the room, and the
  // follow camera passes within about 1.8 of the ball on the way to the
  // stage — close enough that a 0.3-radius ball covers roughly a fifth of
  // the frame. Same answer as the walls: hide the occluder rather than
  // contort the camera around it.
  const overhead = new THREE.Group();
  g.add(overhead);
  const ballGroup = new THREE.Group();
  ballGroup.position.set(0, 2.75, danceZ);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), darkMat);
  cord.position.y = 0.62;
  ballGroup.add(cord);
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0xCFD6E2, roughness: 0.2, metalness: 0.9 })
  );
  ballGroup.add(ball);
  // Facets — small bright squares stuck around the sphere so it reads as a
  // mirror ball rather than a grey marble at this size.
  const facetMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
  for (let i = 0; i < 46; i++) {
    const a = i * 2.399963, y = 1 - (i / 45) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const facet = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), facetMat);
    facet.position.set(Math.cos(a) * r * 0.3, y * 0.3, Math.sin(a) * r * 0.3);
    facet.lookAt(facet.position.clone().multiplyScalar(2));
    ballGroup.add(facet);
  }
  overhead.add(ballGroup);

  // ---- lighting truss over the floor ----
  const truss = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, PARTY_ROOM_W - 0.6, 10), darkMat);
  truss.rotation.z = Math.PI / 2;
  truss.position.set(0, 3.15, danceZ - 1.9);
  overhead.add(truss);
  [-1.8, -0.6, 0.6, 1.8].forEach((px, i) => {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.3, 14), darkMat);
    can.position.set(px, 2.98, danceZ - 1.9);
    can.rotation.x = 0.5;
    overhead.add(can);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.13, 14),
      new THREE.MeshBasicMaterial({ color: i % 2 ? PARTY_NEON_C : PARTY_CYAN_C })
    );
    lens.position.set(px, 2.85, danceZ - 1.83);
    lens.rotation.x = -Math.PI / 2 + 0.5;
    // Tagged rather than collected here, because the material clone below
    // replaces every material in this group — an array captured now would
    // hold references to the originals and animate()'s color cycling would
    // quietly stop showing up.
    lens.userData.parLens = true;
    overhead.add(lens);
  });

  // Both fading groups need their OWN materials before animate() can fade
  // them.
  // Two reasons, and the second is the dangerous one: MeshStandardMaterial
  // ignores `opacity` entirely unless `transparent` is set, so the fade
  // would silently do nothing — and the wall/neon materials are shared with
  // the side walls, the far wall and every other neon strip in the room, so
  // the moment it DID work it would fade half the club along with the
  // entrance. Cloning per-mesh here is what keeps the cutaway local.
  [southWall, overhead].forEach((grp) => {
    grp.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.transparent = true;
    });
  });

  // Collected only now that the clones above are in place.
  const parCans = [];
  overhead.traverse((o) => { if (o.userData && o.userData.parLens) parCans.push(o); });

  return { group: g, colliders, platforms, southWall, overhead, dancePanels, discoBall: ballGroup, parCans };
}

let partyScene = null, partyCamera = null, partyRenderer = null;
let partyAnimId = null, partyClock = null;
let partyAvatarRoot = null, partyColliders = [];
let partyPlatforms = [], partyAvatarGroundY = 0;
let partySouthWall = null, partySouthWallFade = 1;
let partyOverhead = null, partyOverheadFade = 1;
let partyDancePanels = [], partyDiscoBall = null, partyParCans = [];
let partyJoystickBase = null, partyJoystickHandlers = null;
// The entrance "Exit" prompt — proximity-gated exactly like the town hall's,
// rather than a button that is simply always on screen.
let nearbyPartyExit = false;

function setPartyWallFade(group, amount) {
  if (!group) return;
  group.visible = amount > 0.02;
  group.traverse((o) => { if (o.isMesh) o.material.opacity = amount; });
}

function partyGroundHeightAt(x, z) {
  let h = 0;
  partyPlatforms.forEach((pf) => {
    if (x >= pf.minX && x <= pf.maxX && z >= pf.minZ && z <= pf.maxZ && pf.height > h) h = pf.height;
  });
  return h;
}

function resolvePartyCollisions(pos, radius) {
  partyColliders.forEach((c) => {
    const closestX = Math.max(c.x - c.hw, Math.min(pos.x, c.x + c.hw));
    const closestZ = Math.max(c.z - c.hh, Math.min(pos.z, c.z + c.hh));
    const dx = pos.x - closestX, dz = pos.z - closestZ;
    const d = Math.hypot(dx, dz);
    if (d < radius && d > 0.0001) {
      const push = radius - d;
      pos.x += (dx / d) * push;
      pos.z += (dz / d) * push;
    }
  });
  return pos;
}

function teardownPartyHallInteriorScene() {
  if (partyAnimId !== null) cancelAnimationFrame(partyAnimId);
  partyAnimId = null;
  if (partyRenderer) {
    partyRenderer.dispose();
    if (partyRenderer.forceContextLoss) partyRenderer.forceContextLoss();
    partyRenderer = null;
  }
  if (partyJoystickBase && partyJoystickHandlers) {
    partyJoystickBase.removeEventListener('pointerdown', partyJoystickHandlers.down);
    partyJoystickBase.removeEventListener('pointermove', partyJoystickHandlers.move);
    partyJoystickBase.removeEventListener('pointerup', partyJoystickHandlers.up);
    partyJoystickBase.removeEventListener('pointercancel', partyJoystickHandlers.up);
    partyJoystickBase.removeEventListener('lostpointercapture', partyJoystickHandlers.up);
    window.removeEventListener('pointerup', partyJoystickHandlers.up);
    window.removeEventListener('pointercancel', partyJoystickHandlers.up);
    window.removeEventListener('blur', partyJoystickHandlers.reset);
  }
  partyJoystickBase = null;
  partyJoystickHandlers = null;
  partyScene = null;
  partyCamera = null;
  partyAvatarRoot = null;
  partyColliders = [];
  partyPlatforms = [];
  partyAvatarGroundY = 0;
  partySouthWall = null;
  partySouthWallFade = 1;
  partyOverhead = null;
  partyOverheadFade = 1;
  partyDancePanels = [];
  partyDiscoBall = null;
  partyParCans = [];
  nearbyPartyExit = false;
}

// The colors the dance floor and par cans cycle through.
const PARTY_LIGHT_COLORS = [0xFF3FB0, 0x35E0E8, 0xFFC93C, 0x9B5FE8, 0x5FE884];

function initPartyHallInteriorScene() {
  teardownPartyHallInteriorScene();
  const holder = document.getElementById('partyHallScene');
  if (!holder || typeof THREE === 'undefined') return;

  partyScene = new THREE.Scene();
  partyScene.background = new THREE.Color(0x140A1E);

  partyCamera = new THREE.PerspectiveCamera(50, holder.clientWidth / holder.clientHeight, 0.1, 60);

  partyRenderer = new THREE.WebGLRenderer({ antialias: true });
  partyRenderer.setSize(holder.clientWidth, holder.clientHeight);
  partyRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  partyRenderer.shadowMap.enabled = true;
  partyRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  partyRenderer.toneMapping = THREE.LinearToneMapping;
  partyRenderer.toneMappingExposure = 1.0;
  holder.appendChild(partyRenderer.domElement);

  // Deliberately dim ambient light — this is a club, and the room is meant
  // to be lit by its own neon and the two colored spots below rather than
  // by daylight. Too much hemisphere light here washes the neon out and the
  // room stops reading as a party at all.
  partyScene.add(new THREE.HemisphereLight(0xB98CFF, 0x2A1338, 0.5));
  const key = new THREE.DirectionalLight(0xE8D2FF, 0.45);
  key.position.set(3, 7, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 6;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  partyScene.add(key);
  // Two colored spots over the dance floor that animate() swings around.
  const spotA = new THREE.PointLight(PARTY_NEON_C, 9, 7.5, 2);
  const spotB = new THREE.PointLight(PARTY_CYAN_C, 9, 7.5, 2);
  spotA.position.set(-1.4, 2.6, 0.9);
  spotB.position.set(1.4, 2.6, 0.9);
  partyScene.add(spotA);
  partyScene.add(spotB);

  const built = buildPartyHallInterior();
  partyScene.add(built.group);
  partyColliders = built.colliders;
  partyPlatforms = built.platforms;
  partySouthWall = built.southWall;
  partyOverhead = built.overhead;
  partyDancePanels = built.dancePanels;
  partyDiscoBall = built.discoBall;
  partyParCans = built.parCans;

  partyAvatarRoot = new THREE.Group();
  const avatarModel = new THREE.Group();
  const avatarCharacter = buildCharacter(state.character);
  avatarModel.add(avatarCharacter);
  avatarModel.scale.setScalar(VILLAGE_MODEL_SCALE);
  avatarModel.position.y = -(GROUND_Y + FOOT_MARGIN) * VILLAGE_MODEL_SCALE;
  partyAvatarRoot.add(avatarModel);
  const spawnZ = PARTY_HALF_D - 0.9;
  partyAvatarRoot.position.set(0, 0, spawnZ);
  partyAvatarRoot.rotation.y = Math.PI;
  partyScene.add(partyAvatarRoot);

  partyCamera.position.set(0, PARTY_CAM_HEIGHT, partyCamZFor(spawnZ));
  partyCamera.lookAt(0, PARTY_CAM_LOOK_HEIGHT, spawnZ);

  partyClock = new THREE.Clock();

  const JOYSTICK_MAX = 40;
  const joystickVec = { x: 0, z: 0 };
  partyJoystickBase = document.getElementById('partyJoystickBase');
  const joystickKnob = document.getElementById('partyJoystickKnob');
  let joystickPointerId = null;

  function updateJoystickFromEvent(e) {
    const rect = partyJoystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_MAX) {
      dx = (dx / dist) * JOYSTICK_MAX;
      dy = (dy / dist) * JOYSTICK_MAX;
    }
    joystickVec.x = dx / JOYSTICK_MAX;
    joystickVec.z = dy / JOYSTICK_MAX;
    joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  function resetJoystick() {
    joystickPointerId = null;
    joystickVec.x = 0;
    joystickVec.z = 0;
    joystickKnob.style.transform = 'translate(0px, 0px)';
  }
  const onJoystickDown = (e) => {
    joystickPointerId = e.pointerId;
    // See the same try/catch in the village screen's own joystick.
    try { partyJoystickBase.setPointerCapture(e.pointerId); } catch (err) {}
    updateJoystickFromEvent(e);
  };
  const onJoystickMove = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    // See the same buttons===0 check in the village screen's own joystick.
    if (e.buttons === 0) { resetJoystick(); return; }
    updateJoystickFromEvent(e);
  };
  const onJoystickUp = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    resetJoystick();
  };
  if (partyJoystickBase) {
    partyJoystickHandlers = { down: onJoystickDown, move: onJoystickMove, up: onJoystickUp, reset: resetJoystick };
    partyJoystickBase.addEventListener('pointerdown', onJoystickDown);
    partyJoystickBase.addEventListener('pointermove', onJoystickMove);
    partyJoystickBase.addEventListener('pointerup', onJoystickUp);
    partyJoystickBase.addEventListener('pointercancel', onJoystickUp);
    partyJoystickBase.addEventListener('lostpointercapture', onJoystickUp);
    window.addEventListener('pointerup', onJoystickUp);
    window.addEventListener('pointercancel', onJoystickUp);
    window.addEventListener('blur', resetJoystick);
  }

  let walkPhase = 0, walkAmount = 0, clubTime = 0;

  function animate() {
    partyAnimId = requestAnimationFrame(animate);
    const dt = Math.min(partyClock.getDelta(), 0.05);
    clubTime += dt;

    const mag = Math.min(1, Math.hypot(joystickVec.x, joystickVec.z));
    const pushed = mag > 0.08;
    if (pushed) {
      const invMag = 1 / (Math.hypot(joystickVec.x, joystickVec.z) || 1);
      const dirX = joystickVec.x * invMag;
      const dirZ = joystickVec.z * invMag;
      const pos = partyAvatarRoot.position;
      const step = AVATAR_SPEED * mag * dt;
      pos.x += dirX * step;
      pos.z += dirZ * step;
      // A loose outer safety net, not the real boundary — the wall colliders
      // do the actual containment (same split as the town hall). Sized to
      // the walls' own inner faces rather than to the avatar's radius, so
      // the colliders always stop him first and this only ever catches a
      // genuine geometry mistake. An earlier, tighter version of this line
      // was quietly doing the containment itself 3cm before the walls,
      // which made the comment above a lie and would have hidden a missing
      // wall collider completely.
      const inner = PARTY_WALL_T / 2;
      pos.x = Math.max(-PARTY_HALF_W + inner, Math.min(PARTY_HALF_W - inner, pos.x));
      // The south edge is the exception: there is deliberately no collider
      // across the doorway, so this is what stops him in it.
      pos.z = Math.max(-PARTY_HALF_D + inner, Math.min(PARTY_HALF_D - AVATAR_RADIUS - 0.15, pos.z));
      resolvePartyCollisions(pos, AVATAR_RADIUS);
      const targetAngle = Math.atan2(dirX, dirZ);
      partyAvatarRoot.rotation.y = smoothAngle(partyAvatarRoot.rotation.y, targetAngle, dt);
    }

    if (pushed) walkPhase += dt * 9;
    walkAmount += ((pushed ? 1 : 0) - walkAmount) * Math.min(1, dt * 10);
    poseWalkCycle(avatarCharacter, walkPhase, walkAmount);

    // Ride up onto the stage and its steps, eased so a step up reads as a
    // stride rather than a teleport.
    const followPos = partyAvatarRoot.position;
    const targetGroundY = partyGroundHeightAt(followPos.x, followPos.z);
    partyAvatarGroundY += (targetGroundY - partyAvatarGroundY) * Math.min(1, dt * 12);
    partyAvatarRoot.position.y = partyAvatarGroundY;

    const desiredCamPos = { x: followPos.x, y: PARTY_CAM_HEIGHT + partyAvatarGroundY, z: partyCamZFor(followPos.z) };
    const camLerp = 1 - Math.pow(0.001, dt);
    partyCamera.position.x += (desiredCamPos.x - partyCamera.position.x) * camLerp;
    partyCamera.position.y += (desiredCamPos.y - partyCamera.position.y) * camLerp;
    partyCamera.position.z += (desiredCamPos.z - partyCamera.position.z) * camLerp;
    partyCamera.lookAt(followPos.x, PARTY_CAM_LOOK_HEIGHT + partyAvatarGroundY, followPos.z);

    // Wall cutaway. This room is a single rectangle and the camera always
    // looks north, so the entrance wall is the only one that can ever come
    // between the camera and the avatar. The toggle uses the camera's own z,
    // so it flips exactly where the wall stops being behind the camera and
    // starts blocking the shot — invisible either way at that instant, so
    // nothing pops. Purely visual: the wall collider stays solid.
    const camZ = partyCamera.position.z;
    const southBlocking = camZ > PARTY_HALF_D && followPos.z < PARTY_HALF_D;
    partySouthWallFade += ((southBlocking ? 0 : 1) - partySouthWallFade) * Math.min(1, dt * 8);
    setPartyWallFade(partySouthWall, partySouthWallFade);

    // The hanging rig fades out as the camera closes on it. Unlike the wall
    // this needs a real fade rather than a toggle: the ball is a small object
    // the camera slides past, so there's no instant where it's hidden by
    // something else and a hard cut would visibly pop. By the time it's gone
    // the player is at the steps with the stage ahead, where it would only
    // ever be behind the shot anyway.
    const overheadTarget = Math.max(0, Math.min(1, (camZ - 1.3) / 1.4));
    partyOverheadFade += (overheadTarget - partyOverheadFade) * Math.min(1, dt * 8);
    setPartyWallFade(partyOverhead, partyOverheadFade);

    // The club actually running: the dance floor chases colors across itself
    // on a diagonal, the par cans pulse, the spots swing, and the mirror ball
    // turns. All cheap — no extra lights per panel, just material colors.
    partyDancePanels.forEach((panel, i) => {
      const col = i % 5, row = Math.floor(i / 5);
      const idx = Math.floor(clubTime * 3 + col + row) % PARTY_LIGHT_COLORS.length;
      panel.material.color.setHex(PARTY_LIGHT_COLORS[idx]);
      panel.material.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(clubTime * 4 + col - row));
    });
    partyParCans.forEach((lens, i) => {
      const idx = Math.floor(clubTime * 2 + i * 2) % PARTY_LIGHT_COLORS.length;
      lens.material.color.setHex(PARTY_LIGHT_COLORS[idx]);
    });
    if (partyDiscoBall) partyDiscoBall.rotation.y += dt * 0.8;
    spotA.position.x = Math.sin(clubTime * 0.9) * 2.2;
    spotB.position.x = Math.sin(clubTime * 0.9 + Math.PI) * 2.2;
    spotA.intensity = 7 + 3 * Math.sin(clubTime * 6);
    spotB.intensity = 7 + 3 * Math.sin(clubTime * 6 + Math.PI);

    nearbyPartyExit = Math.hypot(0 - followPos.x, PARTY_HALF_D - followPos.z) < ENTER_RADIUS;
    const exitBtn = document.getElementById('partyExitBtn');
    if (exitBtn) exitBtn.style.display = nearbyPartyExit ? '' : 'none';

    partyRenderer.render(partyScene, partyCamera);
  }
  animate();
}

function screenPartyHallInterior() {
  return `
    <div class="screen village-screen">
      <div class="village-plot" style="position:relative; padding:0;">
        <div id="partyHallScene" style="position:absolute; inset:0;"></div>
        <div class="village-overlay-top">
          <div class="chip-row">
            <span class="chip on">Party Hall</span>
          </div>
        </div>
        <div class="joystick-base" id="partyJoystickBase">
          <div class="joystick-knob" id="partyJoystickKnob"></div>
        </div>
        <div class="village-action-row">
          <button class="talk-btn" id="partyExitBtn" style="display:none;" onclick="exitPartyHall()">Exit</button>
        </div>
      </div>
      ${renderNavbar('village')}
    </div>
  `;
}

// ---------- Render ----------

// ---------- The player's home interior ----------
//
// Same module shape the Town Hall and Party Hall interiors settled on — its
// own scene/camera/renderer globals, its own box collision resolver, a fixed
// follow camera with a south-wall cutaway for occlusion, and
// playScreenTransition() on the way in and out. What it adds is furniture the
// player buys and positions themselves, so unlike those two rooms its
// contents are state, not a hand-authored build.

// Deliberately small. The hall is 8.0 x 10.5 because it is civic; a home
// that size reads as a warehouse. This is roughly three of the player's own
// body-lengths across, which is what makes it feel like a room to live in.
const HOME_ROOM_W = 5.5;
const HOME_ROOM_D = 6.5;
const HOME_HALF_W = HOME_ROOM_W / 2;
const HOME_HALF_D = HOME_ROOM_D / 2;
const HOME_WALL_H = 2.4;
const HOME_WALL_T = 0.18;
const HOME_DOOR_W = 1.1;

// The furniture grid. 0.5 rather than the village's 1.0 because the avatar
// stands about 1.17 tall in here: on a 1.0 grid the smallest possible item
// would be half a person wide, and a bed would come out longer than the room
// is comfortable. At 0.5 a single cell is a plant pot and a bed is 2x3.
const HOME_CELL = 0.5;
const HOME_COLS = 10;
const HOME_ROWS = 12;

// The grid is centred in the room, leaving a 0.5 margin to every wall so
// nothing can be placed hard against one (which would bury its back face and
// leave the player unable to walk round it).
function homeGridToWorld(col, row) {
  return {
    x: (col - (HOME_COLS - 1) / 2) * HOME_CELL,
    z: (row - (HOME_ROWS - 1) / 2) * HOME_CELL,
  };
}

function homeFootprintCenter(col, row, w, h) {
  return homeGridToWorld(col + (w - 1) / 2, row + (h - 1) / 2);
}

// ---- The catalogue ----------------------------------------------------
// `w`/`h` are footprint in grid cells. `collide` is the half-extent box the
// player bumps into, in world units — null for anything you should be able
// to walk over, which is why a rug has none.
const HOME_ITEMS = [
  { id: 'rug',       name: 'Rug',        cost: 25, w: 4, h: 3 },
  { id: 'bed',       name: 'Bed',        cost: 90, w: 2, h: 3 },
  { id: 'sofa',      name: 'Sofa',       cost: 70, w: 3, h: 2 },
  { id: 'table',     name: 'Table',      cost: 55, w: 2, h: 2 },
  { id: 'bookshelf', name: 'Bookshelf',  cost: 60, w: 2, h: 1 },
  { id: 'tv',        name: 'TV',         cost: 85, w: 2, h: 1 },
  { id: 'plant',     name: 'Plant',      cost: 20, w: 1, h: 1 },
  { id: 'lamp',      name: 'Lamp',       cost: 30, w: 1, h: 1 },
];

function getHomeItem(id) {
  return HOME_ITEMS.find((it) => it.id === id) || null;
}

// Wall and floor palettes. Free to change and changeable any time — paint
// isn't a purchase, so a player who has spent everything on furniture can
// still make the room theirs.
const HOME_WALL_COLORS = ['#E9DCC6', '#DCE6E9', '#E9D6DC', '#DDE9D6', '#EDE3F2', '#D9D4CC', '#F2E4C4', '#CFE0EA'];
const HOME_FLOOR_COLORS = ['#B98A55', '#8C6239', '#C9A876', '#7A6A58', '#A8794B', '#6E5B7B', '#9BA88C', '#D7C4A3'];

function homeState() {
  if (!state.home) state.home = { items: [], wall: HOME_WALL_COLORS[0], floor: HOME_FLOOR_COLORS[0] };
  if (!Array.isArray(state.home.items)) state.home.items = [];
  if (!state.home.wall) state.home.wall = HOME_WALL_COLORS[0];
  if (!state.home.floor) state.home.floor = HOME_FLOOR_COLORS[0];
  return state.home;
}

// Which grid cells are taken. Rebuilt on demand rather than cached, so it can
// never fall out of step with what is actually in the room.
function homeOccupancy(excludeUid) {
  const grid = [];
  for (let r = 0; r < HOME_ROWS; r++) grid.push(new Array(HOME_COLS).fill(null));
  homeState().items.forEach((placed) => {
    if (placed.uid === excludeUid) return;
    const item = getHomeItem(placed.type);
    if (!item) return;
    for (let r = placed.row; r < placed.row + item.h; r++) {
      for (let c = placed.col; c < placed.col + item.w; c++) {
        if (r >= 0 && r < HOME_ROWS && c >= 0 && c < HOME_COLS) grid[r][c] = placed.uid;
      }
    }
  });
  return grid;
}

// The square the player stands on when they walk in, and the square they are
// returned to after every placement. Kept permanently clear: if furniture
// could be dropped here the player would be put back inside a wardrobe, and
// the doorway itself could be walled off. A 2x2 block of cells (1.0 x 1.0)
// rather than the single cell the avatar occupies, because the avatar is 0.52
// across and needs clearance on every side of it, not just underneath.
const HOME_SPAWN_COLS = [4, 5];
const HOME_SPAWN_ROWS = [HOME_ROWS - 2, HOME_ROWS - 1];
const HOME_SPAWN_POINT = {
  x: (((HOME_SPAWN_COLS[0] + HOME_SPAWN_COLS[1]) / 2) - (HOME_COLS - 1) / 2) * HOME_CELL,
  z: (((HOME_SPAWN_ROWS[0] + HOME_SPAWN_ROWS[1]) / 2) - (HOME_ROWS - 1) / 2) * HOME_CELL,
};

function homeCellReserved(col, row) {
  return col >= HOME_SPAWN_COLS[0] && col <= HOME_SPAWN_COLS[1] &&
         row >= HOME_SPAWN_ROWS[0] && row <= HOME_SPAWN_ROWS[1];
}

function homeSpotFree(occupancy, col, row, w, h) {
  if (col < 0 || row < 0 || col + w > HOME_COLS || row + h > HOME_ROWS) return false;
  for (let r = row; r < row + h; r++) {
    for (let c = col; c < col + w; c++) {
      if (occupancy[r][c]) return false;
      if (homeCellReserved(c, r)) return false;
    }
  }
  return true;
}

function homeFindFreeSpot(occupancy, w, h) {
  // Search outward from the middle of the floor, so a newly bought item
  // starts somewhere the player can actually see it rather than tucked in a
  // corner behind the camera.
  const midCol = Math.floor((HOME_COLS - w) / 2), midRow = Math.floor((HOME_ROWS - h) / 2);
  for (let ring = 0; ring < Math.max(HOME_COLS, HOME_ROWS); ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        if (homeSpotFree(occupancy, midCol + dc, midRow + dr, w, h)) {
          return { col: midCol + dc, row: midRow + dr };
        }
      }
    }
  }
  return null;
}

// ---- Furniture models -------------------------------------------------
// Same low-poly vocabulary as the village structures: boxes and cylinders,
// one flat material per part, no textures. Everything is modelled around the
// avatar's real height in here (about 1.17), which is why a table top sits at
// 0.34 rather than a realistic 0.75 — scaled to the character, not to metres.

function makeHomeRug() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.03, 1.4),
    new THREE.MeshStandardMaterial({ color: 0xC4586B, roughness: 0.95 })
  );
  base.position.y = 0.015;
  base.receiveShadow = true;
  g.add(base);
  const inner = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.034, 1.05),
    new THREE.MeshStandardMaterial({ color: 0xE8D9B5, roughness: 0.95 })
  );
  inner.position.y = 0.018;
  g.add(inner);
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.038, 0.55),
    new THREE.MeshStandardMaterial({ color: 0xC4586B, roughness: 0.95 })
  );
  core.position.y = 0.02;
  g.add(core);
  return g;
}

function makeHomeBed() {
  const g = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color: 0x8B5E34, roughness: 0.85 });
  const frameDark = new THREE.MeshStandardMaterial({ color: 0x6E4826, roughness: 0.85 });
  const sheet = new THREE.MeshStandardMaterial({ color: 0xF2EDE2, roughness: 0.9 });
  const quiltMat = new THREE.MeshStandardMaterial({ color: 0x5C8AA6, roughness: 0.92 });

  const ellipsoid = (w, h, d, mat) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), mat);
    m.scale.set(w, h, d);   // radius 0.5 => diameter 1, so scale IS the size
    m.castShadow = true;
    return m;
  };
  // Same body-plus-crown trick the sofa cushions use: a box keeps the crisp
  // edge that holds the shape, the domed top catches light and reads as soft.
  const soft = (w, h, d, x, y, z, mat) => {
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    body.position.set(x, y, z);
    body.castShadow = true;
    g.add(body);
    const crown = ellipsoid(w, h, d, mat);
    crown.position.set(x, y + h * 0.5, z);
    g.add(crown);
  };

  // The old bed was four flat slabs stacked barely 0.38 high, which is why it
  // read as a rug with a headboard. This one is built up: legs lift it off the
  // floor, the mattress and quilt are given real thickness and a domed top,
  // and the headboard is tall enough to be furniture rather than a lip.
  [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.15, 0.09), frameDark);
    leg.position.set(sx * 0.4, 0.075, sz * 0.63);
    leg.castShadow = true;
    g.add(leg);
  }));

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.11, 1.44), frame);
  base.position.y = 0.2;
  base.castShadow = true;
  g.add(base);

  // Two lessons landed here, both from getting it wrong first.
  //
  // The body-and-crown trick that softened the sofa cushions does NOT scale
  // up. An ellipsoid stretched to 0.9 x 1.3 is a metre-wide dome, and from
  // above its silhouette is an ellipse inscribed in a rectangle — it read as
  // a giant flat disc lying on the bed.
  //
  // Stacking inset boxes to fake a bevel instead was no better: at three
  // layers the bedding read as a stack of plates, every inset showing as a
  // hard ledge. So the mattress and quilt are each ONE clean slab, and the
  // softness comes from the quilt overhanging the mattress on three sides —
  // which is what a real quilt does, and is legible at any size.
  const mattress = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.2, 1.34), sheet);
  mattress.position.set(0, 0.34, 0);
  mattress.castShadow = true;
  g.add(mattress);

  // The quilt was still just a blue box: one flat colour, six flat faces, no
  // reason for the eye to read it as bedding. From the room camera you mostly
  // see its TOP, so that face gets a real quilted surface — padded panels with
  // stitched seams between them — while the sides stay plain. A BoxGeometry
  // takes six materials in +x,-x,+y,-y,+z,-z order, so this costs one extra
  // material and no extra geometry.
  const quiltTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#5C8AA6';
    ctx.fillRect(0, 0, w, h);
    const N = 3, pad = w / N;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const x = c * pad, y = r * pad;
        // Each panel is a puffed square: lighter in the middle, falling off
        // toward its seams, which is what padding does to light.
        const grad = ctx.createRadialGradient(x + pad / 2, y + pad / 2, pad * 0.1,
                                              x + pad / 2, y + pad / 2, pad * 0.62);
        grad.addColorStop(0, '#79A6C0');
        grad.addColorStop(1, '#5C8AA6');
        ctx.fillStyle = grad;
        ctx.fillRect(x + 3, y + 3, pad - 6, pad - 6);
      }
    }
    ctx.strokeStyle = 'rgba(40,66,84,0.55)';
    ctx.lineWidth = 4;
    for (let i = 1; i < N; i++) {
      ctx.beginPath(); ctx.moveTo(i * pad, 0); ctx.lineTo(i * pad, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * pad); ctx.lineTo(w, i * pad); ctx.stroke();
    }
  });
  const quiltTopMat = new THREE.MeshStandardMaterial({ map: quiltTex, roughness: 0.92 });
  const quilt = new THREE.Mesh(
    new THREE.BoxGeometry(0.94, 0.14, 0.92),
    [quiltMat, quiltMat, quiltTopMat, quiltMat, quiltMat, quiltMat]
  );
  quilt.position.set(0, 0.51, 0.2);
  quilt.castShadow = true;
  g.add(quilt);
  // A rolled edge where the duvet turns over at the foot. Square-cut bedding
  // is the other half of why it read as a slab — real bedding has no sharp
  // corners anywhere.
  const quiltRoll = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.94, 14), quiltMat);
  quiltRoll.rotation.z = Math.PI / 2;
  quiltRoll.position.set(0, 0.51, 0.66);
  quiltRoll.castShadow = true;
  g.add(quiltRoll);

  // Turned-down sheet along the quilt's head edge — the detail that says
  // "made bed" rather than "slab with a blanket on it".
  const turn = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.08, 0.16), sheet);
  turn.position.set(0, 0.52, -0.29);
  turn.castShadow = true;
  g.add(turn);

  [-1, 1].forEach((side) => {
    soft(0.38, 0.14, 0.3, side * 0.22, 0.51, -0.5, sheet);
  });

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.6, 0.08), frame);
  head.position.set(0, 0.5, -0.69);
  head.castShadow = true;
  g.add(head);
  const headRail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.98, 14), frame);
  headRail.rotation.z = Math.PI / 2;
  headRail.position.set(0, 0.8, -0.69);
  headRail.castShadow = true;
  g.add(headRail);

  // A low footboard closes the shape off — without it the bed just stops.
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.26, 0.08), frame);
  foot.position.set(0, 0.33, 0.69);
  foot.castShadow = true;
  g.add(foot);
  const footRail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.98, 14), frame);
  footRail.rotation.z = Math.PI / 2;
  footRail.position.set(0, 0.46, 0.69);
  footRail.castShadow = true;
  g.add(footRail);

  return g;
}

function makeHomeSofa() {
  const g = new THREE.Group();
  const fabric = new THREE.MeshStandardMaterial({ color: 0x6E8E6A, roughness: 0.92 });
  const cushionMat = new THREE.MeshStandardMaterial({ color: 0x86AA80, roughness: 0.95 });
  const pillowMat = new THREE.MeshStandardMaterial({ color: 0xD98C5F, roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x4A3524, roughness: 0.85 });

  // The base sphere has radius 0.5, so its DIAMETER is already 1.0 — scaling
  // by w gives a shape w wide. Dividing by the radius instead (w / 0.5) makes
  // everything exactly twice the size asked for, which is what pushed the
  // cushions 0.1 out past the arms on each side and 0.14 past the front.
  const ellipsoid = (w, h, d, mat) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), mat);
    m.scale.set(w, h, d);
    m.castShadow = true;
    return m;
  };

  // A cushion is a squared-off body with a domed top, not a plain box and not
  // a plain blob. The first pass used flat boxes, which is what made it look
  // hard. Replacing them with pure ellipsoids then went too far the other
  // way — fully rounded cushions bulge past the frame on every axis and the
  // sofa turns into a heap of beanbags with legs. Body plus crown keeps a
  // crisp horizontal edge where the two meet, which reads as piping and holds
  // the sofa's shape at the size it's actually drawn on screen.
  const cushion = (w, h, d, x, y, z, tilt) => {
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), cushionMat);
    body.position.set(x, y, z);
    body.rotation.x = tilt || 0;
    body.castShadow = true;
    g.add(body);
    const crown = ellipsoid(w, h, d, cushionMat);
    crown.position.set(x, y + h * 0.5, z + (tilt ? 0.04 : 0));
    crown.rotation.x = tilt || 0;
    g.add(crown);
  };

  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.16, 0.72), fabric);
  seat.position.y = 0.24;
  seat.castShadow = true;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.38, 0.16), fabric);
  back.position.set(0, 0.43, -0.28);
  back.castShadow = true;
  g.add(back);

  [-1, 1].forEach((side) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.26, 0.72), fabric);
    arm.position.set(side * 0.63, 0.37, 0);
    arm.castShadow = true;
    g.add(arm);
    // Rolled top on each arm. Square-edged arms next to soft cushions read as
    // neither one thing nor the other, so the arms get a soft edge too.
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.72, 14), fabric);
    roll.rotation.x = Math.PI / 2;
    roll.position.set(side * 0.63, 0.50, 0);
    roll.castShadow = true;
    g.add(roll);
    [-1, 1].forEach((fb) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.08), dark);
      leg.position.set(side * 0.58, 0.08, fb * 0.28);
      g.add(leg);
    });
  });

  // Sized to the 1.12 gap between the arms so nothing intersects the frame,
  // and set a touch low so the cushions read as pressed into the seat rather
  // than balanced on top of it.
  [-1, 1].forEach((side) => {
    cushion(0.52, 0.10, 0.50, side * 0.28, 0.37, 0.06, 0);
    cushion(0.52, 0.24, 0.10, side * 0.28, 0.50, -0.17, -0.13);
  });

  // Throw pillows tipped into the corners. The cheapest thing that makes a
  // piece read as lived-in rather than showroom, and the contrast colour
  // stops the whole sofa being one flat block of sage.
  [-1, 1].forEach((side) => {
    const pillow = ellipsoid(0.26, 0.10, 0.26, pillowMat);
    pillow.position.set(side * 0.44, 0.50, -0.02);
    pillow.rotation.set(-0.35, 0, side * 0.9);
    g.add(pillow);
  });

  return g;
}

function makeHomeTable() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0xC9975B, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x8B5E34, roughness: 0.85 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.07, 0.9), wood);
  top.position.y = 0.34;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);
  [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 0.07), dark);
    leg.position.set(sx * 0.36, 0.17, sz * 0.36);
    leg.castShadow = true;
    g.add(leg);
  }));
  const bowl = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 18, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xE0E4E8, roughness: 0.4 })
  );
  bowl.position.y = 0.44;
  bowl.rotation.x = Math.PI;
  bowl.castShadow = true;
  g.add(bowl);
  [[0.04, 0.44, 0], [-0.05, 0.45, 0.04], [0.01, 0.46, -0.05]].forEach((p, i) => {
    const fruit = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 10),
      new THREE.MeshStandardMaterial({ color: i === 1 ? 0xE0B23C : 0xD1503F, roughness: 0.6 })
    );
    fruit.position.set(p[0], p[1], p[2]);
    g.add(fruit);
  });
  return g;
}

function makeHomeBookshelf() {
  const g = new THREE.Group();
  // Built the same way as the Town Hall office's shelf (see
  // buildTownHallInterior): a solid dark-wood body with a single painted
  // front panel of book spines, rather than modelling every book as its own
  // box. Same makeBookshelfTexture() too, so the two rooms genuinely match
  // instead of being two different shelves that happen to both hold books.
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.2, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x8B5E34, roughness: 0.8 })
  );
  body.position.y = 0.6;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const front = new THREE.Mesh(
    new THREE.PlaneGeometry(0.86, 1.12),
    new THREE.MeshBasicMaterial({ map: makeBookshelfTexture() })
  );
  front.position.set(0, 0.6, 0.152);
  g.add(front);
  return g;
}

function makeHomeTv() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2B2B30, roughness: 0.5, metalness: 0.2 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x8B5E34, roughness: 0.85 });
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.28, 0.32), wood);
  stand.position.y = 0.14;
  stand.castShadow = true;
  g.add(stand);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.1), dark);
  neck.position.y = 0.33;
  g.add(neck);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.5, 0.06), dark);
  panel.position.y = 0.62;
  panel.castShadow = true;
  g.add(panel);
  // A flat emissive-ish face rather than a lit screen — the interior has no
  // bloom, so a bright basic material is what reads as "on" here.
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.42),
    new THREE.MeshBasicMaterial({ color: 0x6FC7D6 })
  );
  screen.position.set(0, 0.62, 0.032);
  g.add(screen);
  return g;
}

function makeHomePlant() {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.1, 0.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xC2703F, roughness: 0.85 })
  );
  pot.position.y = 0.1;
  pot.castShadow = true;
  g.add(pot);
  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(0.115, 0.115, 0.03, 16),
    new THREE.MeshStandardMaterial({ color: 0x4A3524, roughness: 1 })
  );
  soil.position.y = 0.2;
  g.add(soil);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4E9A5A, roughness: 0.8 });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.22, 8), leafMat);
  stem.position.y = 0.3;
  g.add(stem);
  [[0, 0.44, 0, 0.15], [0.11, 0.38, 0.05, 0.11], [-0.1, 0.37, -0.06, 0.11],
   [0.03, 0.33, -0.11, 0.09], [-0.06, 0.34, 0.1, 0.09]].forEach(([x, y, z, r]) => {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), leafMat);
    leaf.position.set(x, y, z);
    leaf.scale.set(1, 0.72, 1);
    leaf.castShadow = true;
    g.add(leaf);
  });
  return g;
}

function makeHomeLamp() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x4A4A52, roughness: 0.5, metalness: 0.4 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.04, 18), metal);
  base.position.y = 0.02;
  base.castShadow = true;
  g.add(base);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.78, 10), metal);
  pole.position.y = 0.42;
  pole.castShadow = true;
  g.add(pole);
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.19, 0.22, 18, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xF2E2B8, roughness: 0.9, side: THREE.DoubleSide })
  );
  shade.position.y = 0.9;
  shade.castShadow = true;
  g.add(shade);
  // A warm disc under the shade so the lamp reads as switched on without
  // paying for a real light source in a room that already has two.
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.17, 18),
    new THREE.MeshBasicMaterial({ color: 0xFFE8B0 })
  );
  glow.position.y = 0.792;
  glow.rotation.x = -Math.PI / 2;
  g.add(glow);
  return g;
}

// Footprint in cells drives the grid; `collide` is what the player bumps
// into. A rug has none on purpose — you walk over a rug.
const HOME_MODELS = {
  rug:       { build: makeHomeRug,       collide: null },
  bed:       { build: makeHomeBed,       collide: { hw: 0.49, hh: 0.74 } },
  sofa:      { build: makeHomeSofa,      collide: { hw: 0.72, hh: 0.38 } },
  table:     { build: makeHomeTable,     collide: { hw: 0.47, hh: 0.47 } },
  bookshelf: { build: makeHomeBookshelf, collide: { hw: 0.45, hh: 0.16 } },
  tv:        { build: makeHomeTv,        collide: { hw: 0.47, hh: 0.18 } },
  plant:     { build: makeHomePlant,     collide: { hw: 0.15, hh: 0.15 } },
  lamp:      { build: makeHomeLamp,      collide: { hw: 0.16, hh: 0.16 } },
};

// ---- The room ---------------------------------------------------------

function buildHomeInterior() {
  const home = homeState();
  const g = new THREE.Group();
  const colliders = [];
  const wallBox = (cx, cz, hw, hh) => colliders.push({ x: cx, z: cz, hw, hh });

  const wallMat = new THREE.MeshStandardMaterial({ color: home.wall, roughness: 0.92 });
  const floorMat = new THREE.MeshStandardMaterial({ color: home.floor, roughness: 0.85 });
  const trimMat = new THREE.MeshStandardMaterial({ color: shadeColor(home.wall, -0.28), roughness: 0.8 });

  const floor = new THREE.Mesh(new THREE.BoxGeometry(HOME_ROOM_W, 0.12, HOME_ROOM_D), floorMat);
  floor.position.y = -0.06;
  floor.receiveShadow = true;
  g.add(floor);

  // The room used to be an open box floating in empty backdrop, which on a
  // wide window left the house marooned in a void. Zooming can't fix that:
  // covering a 16:9 frame with a 5.5-wide room needs the camera inside the
  // room, which throws away the whole dollhouse view. So instead the room
  // gets a surround — a large deck at floor level that runs past every wall
  // and out under the doorway. It reads as the rest of the house the cutaway
  // is carved out of, and it means the frame is filled with floor rather than
  // nothing no matter how wide the window gets.
  const surround = new THREE.Mesh(
    new THREE.BoxGeometry(46, 0.1, 46),
    new THREE.MeshStandardMaterial({ color: shadeColor(home.floor, -0.42), roughness: 0.95 })
  );
  surround.position.y = -0.115;
  surround.receiveShadow = true;
  g.add(surround);

  // Everything on the entrance wall lives in its own group so the cutaway in
  // animate() can drop it all together — a skirting board left hanging in
  // mid-air after its wall vanished looks worse than the occlusion it solves.
  const southWall = new THREE.Group();
  g.add(southWall);

  const addWall = (cx, cz, w, d, parent) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, HOME_WALL_H, d), wallMat);
    m.position.set(cx, HOME_WALL_H / 2, cz);
    m.receiveShadow = true;
    (parent || g).add(m);
    wallBox(cx, cz, w / 2, d / 2);
    return m;
  };
  const addTrim = (cx, cz, w, d, parent) => {
    const t = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), trimMat);
    t.position.set(cx, 0.06, cz);
    (parent || g).add(t);
  };

  addWall(0, -HOME_HALF_D, HOME_ROOM_W, HOME_WALL_T);
  addTrim(0, -HOME_HALF_D + HOME_WALL_T / 2 + 0.02, HOME_ROOM_W, 0.05);
  [-1, 1].forEach((side) => {
    addWall(side * HOME_HALF_W, 0, HOME_WALL_T, HOME_ROOM_D);
    addTrim(side * (HOME_HALF_W - HOME_WALL_T / 2 - 0.02), 0, 0.05, HOME_ROOM_D);
  });
  // Entrance wall, split either side of the doorway.
  const jambW = (HOME_ROOM_W - HOME_DOOR_W) / 2;
  [-1, 1].forEach((side) => {
    const cx = side * (HOME_DOOR_W / 2 + jambW / 2);
    addWall(cx, HOME_HALF_D, jambW, HOME_WALL_T, southWall);
    addTrim(cx, HOME_HALF_D - HOME_WALL_T / 2 - 0.02, jambW, 0.05, southWall);
  });

  // A window on the back wall, so the room has something to look at and a
  // sense of outside. Purely decorative — no collider of its own, it sits in
  // the wall that already has one.
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xF4F1EA, roughness: 0.7 });
  const skyMat = new THREE.MeshBasicMaterial({ color: 0x9FD4E8 });
  const winZ = -HOME_HALF_D + HOME_WALL_T / 2 + 0.015;
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95), skyMat);
  sky.position.set(0, 1.45, winZ);
  g.add(sky);
  [[1.62, 0.06, 0, 1.45 + 0.53], [1.62, 0.06, 0, 1.45 - 0.53]].forEach(([w, h, x, y]) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), frameMat);
    bar.position.set(x, y, winZ + 0.01);
    g.add(bar);
  });
  [-1, 1].forEach((side) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.06, 0.05), frameMat);
    bar.position.set(side * 0.78, 1.45, winZ + 0.01);
    g.add(bar);
  });
  const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.95, 0.05), frameMat);
  mullion.position.set(0, 1.45, winZ + 0.01);
  g.add(mullion);

  // A marker over the reserved entrance square — but ONLY while furniture is
  // being positioned. It exists to explain why the ghost refuses to go there;
  // the rest of the time it was just a discoloured patch on an otherwise
  // clean floor, which is not something anyone asked their house to have.
  if (state.homePlacement) {
    const markC = homeFootprintCenter(HOME_SPAWN_COLS[0], HOME_SPAWN_ROWS[0], 2, 2);
    const mark = new THREE.Mesh(
      new THREE.PlaneGeometry(HOME_CELL * 2 - 0.08, HOME_CELL * 2 - 0.08),
      new THREE.MeshBasicMaterial({ color: 0x2C2A26, transparent: true, opacity: 0.14, depthWrite: false })
    );
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(markC.x, 0.014, markC.z);
    g.add(mark);
  }

  // ---- the player's own furniture ----
  const furniture = new THREE.Group();
  g.add(furniture);
  home.items.forEach((placed) => {
    const item = getHomeItem(placed.type);
    const model = HOME_MODELS[placed.type];
    if (!item || !model) return;
    const center = homeFootprintCenter(placed.col, placed.row, item.w, item.h);
    const node = model.build();
    node.position.set(center.x, 0, center.z);
    node.rotation.y = placed.rot || 0;
    node.userData.homeUid = placed.uid;
    furniture.add(node);
    if (model.collide) {
      // A rotated item swaps its own half-extents — the collider has to turn
      // with the model or a sideways sofa would block the wrong strip of floor.
      const turned = Math.abs(Math.sin(placed.rot || 0)) > 0.5;
      wallBox(center.x, center.z,
        turned ? model.collide.hh : model.collide.hw,
        turned ? model.collide.hw : model.collide.hh);
    }
  });

  return { group: g, colliders, southWall, furniture };
}

// ---- Scene ------------------------------------------------------------

// A fixed dollhouse camera showing the WHOLE room, rather than the follow
// camera the two big interiors use. Those rooms are 8x10 and 8.4x11 — too
// large to take in at once, so the camera has to travel. This one is 5.5x6.5,
// and a room you are decorating is one you need to see all of: with a follow
// camera you place a chair and immediately lose sight of the bed you were
// matching it to. It also sidesteps the follow-camera trap both other
// interiors hit, since a camera that never moves cannot tilt as it moves.
// Positioned directly above the doorway, on the room's centre line, looking
// straight down its length — the view you'd have standing in your own front
// door. An earlier pass put it off to one side for a more three-quarter,
// architectural look; the user preferred this. The near corners either side
// of the doorway fall outside the frame, which is correct rather than a
// crop: they are beside the camera, the way the doorframe is beside you when
// you stand in it.
const HOME_CAM_POS = { x: 0, y: 6.0, z: 6.6 };
const HOME_CAM_LOOK = { x: 0, y: 0.20, z: -0.45 };
const HOME_CAM_FOV = 58;
// What shows above the walls, past the surround's horizon. Kept dark and warm
// so it reads as the shadowed depth of the house rather than as empty space.
const HOME_BACKDROP = 0x3B302A;

// How much of the frame's width the room should try to occupy. Now that a
// surround runs past every wall there is no void to expose, so the camera is
// free to come closer on a wide window and crop into the surround instead of
// leaving the house marooned in the middle.
const HOME_FILL_TARGET = 0.92;

function fitHomeCamera(camera, aspect) {
  camera.aspect = aspect;
  const look = new THREE.Vector3(HOME_CAM_LOOK.x, HOME_CAM_LOOK.y, HOME_CAM_LOOK.z);
  const base = new THREE.Vector3(HOME_CAM_POS.x, HOME_CAM_POS.y, HOME_CAM_POS.z);
  const dir = base.clone().sub(look).normalize();
  const maxD = base.distanceTo(look);
  // Never closer than a metre outside the doorway. Past that the camera is
  // inside the room and the whole dollhouse read — three walls and the floor
  // laid out in front of you — collapses; filling the frame is not worth that.
  const minD = (HOME_HALF_D + 1.0 - look.z) / dir.z;
  const place = (d) => {
    camera.position.copy(look).addScaledVector(dir, d);
    camera.lookAt(look);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  // How far across the frame the side wall lands, as a fraction of half-width.
  const spread = (d) => {
    place(d);
    return Math.abs(new THREE.Vector3(HOME_HALF_W, 0, 0).project(camera).x);
  };
  if (maxD <= minD || spread(maxD) >= HOME_FILL_TARGET) { place(maxD); return; }
  let lo = minD, hi = maxD;      // lo fills more, hi fills less
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (spread(mid) >= HOME_FILL_TARGET) lo = mid; else hi = mid;
  }
  place(spread(lo) >= HOME_FILL_TARGET ? lo : minD);
}

let homeScene = null, homeCamera = null, homeRenderer = null;
let homeAnimId = null, homeClock = null;
let homeAvatarRoot = null, homeColliders = [];
let homeSouthWall = null;
let homeFurnitureGroup = null;
let homeJoystickBase = null, homeJoystickHandlers = null;
let homeGhostGroup = null;
let nearbyHomeExit = false;

function resolveHomeCollisions(pos, radius) {
  homeColliders.forEach((c) => {
    const closestX = Math.max(c.x - c.hw, Math.min(pos.x, c.x + c.hw));
    const closestZ = Math.max(c.z - c.hh, Math.min(pos.z, c.z + c.hh));
    const dx = pos.x - closestX, dz = pos.z - closestZ;
    const d = Math.hypot(dx, dz);
    if (d < radius && d > 0.0001) {
      const push = radius - d;
      pos.x += (dx / d) * push;
      pos.z += (dz / d) * push;
    }
  });
  return pos;
}

function teardownHomeInteriorScene() {
  if (homeAnimId !== null) cancelAnimationFrame(homeAnimId);
  homeAnimId = null;
  if (homeRenderer) {
    homeRenderer.dispose();
    if (homeRenderer.forceContextLoss) homeRenderer.forceContextLoss();
    homeRenderer = null;
  }
  if (homeJoystickBase && homeJoystickHandlers) {
    homeJoystickBase.removeEventListener('pointerdown', homeJoystickHandlers.down);
    homeJoystickBase.removeEventListener('pointermove', homeJoystickHandlers.move);
    homeJoystickBase.removeEventListener('pointerup', homeJoystickHandlers.up);
    homeJoystickBase.removeEventListener('pointercancel', homeJoystickHandlers.up);
    homeJoystickBase.removeEventListener('lostpointercapture', homeJoystickHandlers.up);
    window.removeEventListener('pointerup', homeJoystickHandlers.up);
    window.removeEventListener('pointercancel', homeJoystickHandlers.up);
    window.removeEventListener('blur', homeJoystickHandlers.reset);
  }
  homeJoystickBase = null;
  homeJoystickHandlers = null;
  homeScene = null;
  homeCamera = null;
  homeAvatarRoot = null;
  homeColliders = [];
  homeSouthWall = null;
  homeFurnitureGroup = null;
  homeGhostGroup = null;
  nearbyHomeExit = false;
}

function initHomeInteriorScene() {
  teardownHomeInteriorScene();
  const holder = document.getElementById('homeScene');
  if (!holder || typeof THREE === 'undefined') return;

  homeScene = new THREE.Scene();
  homeScene.background = new THREE.Color(HOME_BACKDROP);

  homeCamera = new THREE.PerspectiveCamera(HOME_CAM_FOV, holder.clientWidth / holder.clientHeight, 0.1, 60);
  homeRenderer = new THREE.WebGLRenderer({ antialias: true });
  homeRenderer.setSize(holder.clientWidth, holder.clientHeight);
  homeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  homeRenderer.shadowMap.enabled = true;
  homeRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  holder.appendChild(homeRenderer.domElement);

  // Warm and soft — a home, not the hall's civic daylight or the club's neon.
  homeScene.add(new THREE.HemisphereLight(0xFFF1DC, 0x8A6A4A, 0.85));
  const sun = new THREE.DirectionalLight(0xFFE9C4, 0.62);
  sun.position.set(2.5, 5, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // The frustum has to contain the WHOLE room, walls included. The room's
  // bounding sphere is 4.89 across the diagonal (2.75 x 2.4 x 3.25 half
  // extents), so the old +-4 box cut through the floor: everything past that
  // edge sampled the shadow map's clamped border texel instead of a real
  // depth, which painted a large soft wedge across the floor that looked like
  // a shadow of nothing. Sized past the diagonal, with near/far pulled in
  // around the light's actual distance for depth precision.
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -6;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 16;
  sun.shadow.bias = -0.0015;
  sun.shadow.normalBias = 0.02;
  homeScene.add(sun);
  // A little bounce from the window end so the far wall isn't dead flat.
  const windowFill = new THREE.DirectionalLight(0xCFE6F5, 0.28);
  windowFill.position.set(0, 2, -4);
  homeScene.add(windowFill);

  const built = buildHomeInterior();
  homeScene.add(built.group);
  homeColliders = built.colliders;
  homeSouthWall = built.southWall;
  homeFurnitureGroup = built.furniture;

  homeAvatarRoot = new THREE.Group();
  const avatarModel = new THREE.Group();
  const avatarCharacter = buildCharacter(state.character);
  avatarModel.add(avatarCharacter);
  avatarModel.scale.setScalar(VILLAGE_MODEL_SCALE);
  avatarModel.position.y = -(GROUND_Y + FOOT_MARGIN) * VILLAGE_MODEL_SCALE;
  homeAvatarRoot.add(avatarModel);
  // Always the reserved entrance square. There is no saved in-house position,
  // so walking in and finishing a placement land the player in exactly the
  // same spot — which is the whole point: nothing can be built on it, so the
  // player can never be returned into a piece of furniture or fenced in.
  homeAvatarRoot.position.set(HOME_SPAWN_POINT.x, 0, HOME_SPAWN_POINT.z);
  homeAvatarRoot.rotation.y = Math.PI;
  // While furniture is being positioned the player is out of the room
  // altogether, so they can never be standing where a piece needs to go.
  homeAvatarRoot.visible = !state.homePlacement;
  homeScene.add(homeAvatarRoot);

  fitHomeCamera(homeCamera, holder.clientWidth / holder.clientHeight);
  // The camera sits south of and above the room, so the entrance wall is
  // permanently between it and everything else. It stays in the collider list
  // (you still can't walk out through it) but is never drawn — the standard
  // dollhouse cutaway, and with a fixed camera there is no moment where it
  // would legitimately be behind the shot, so there is nothing to fade.
  // visible=false, NOT an opacity fade: every wall shares one material
  // instance, so setting opacity on the entrance wall's meshes dimmed the
  // back and side walls with it and the room came out as a black void.
  // Hiding the object leaves the shared material untouched.
  homeSouthWall.visible = false;

  homeClock = new THREE.Clock();
  if (state.homePlacement) buildHomeGhost();

  const JOYSTICK_MAX = 40;
  const joystickVec = { x: 0, z: 0 };
  homeJoystickBase = document.getElementById('homeJoystickBase');
  const joystickKnob = document.getElementById('homeJoystickKnob');
  let joystickPointerId = null;

  function updateJoystickFromEvent(e) {
    const rect = homeJoystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_MAX) { dx = (dx / dist) * JOYSTICK_MAX; dy = (dy / dist) * JOYSTICK_MAX; }
    joystickVec.x = dx / JOYSTICK_MAX;
    joystickVec.z = dy / JOYSTICK_MAX;
    joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  function resetJoystick() {
    joystickPointerId = null;
    joystickVec.x = 0;
    joystickVec.z = 0;
    joystickKnob.style.transform = 'translate(0px, 0px)';
  }
  const onDown = (e) => {
    joystickPointerId = e.pointerId;
    try { homeJoystickBase.setPointerCapture(e.pointerId); } catch (err) {}
    updateJoystickFromEvent(e);
  };
  const onMove = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    if (e.buttons === 0) { resetJoystick(); return; }
    updateJoystickFromEvent(e);
  };
  const onUp = (e) => {
    if (e.pointerId !== joystickPointerId) return;
    resetJoystick();
  };
  if (homeJoystickBase) {
    homeJoystickHandlers = { down: onDown, move: onMove, up: onUp, reset: resetJoystick };
    homeJoystickBase.addEventListener('pointerdown', onDown);
    homeJoystickBase.addEventListener('pointermove', onMove);
    homeJoystickBase.addEventListener('pointerup', onUp);
    homeJoystickBase.addEventListener('pointercancel', onUp);
    homeJoystickBase.addEventListener('lostpointercapture', onUp);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', resetJoystick);
  }

  let walkPhase = 0, walkAmount = 0;
  // In placement mode the stick nudges the ghost a cell at a time rather than
  // steering the avatar, so the same control does both jobs without a second
  // on-screen stick. The repeat delay is what stops one flick skating the
  // ghost across the whole room.
  let ghostRepeat = 0;

  function animate() {
    homeAnimId = requestAnimationFrame(animate);
    if (!homeRenderer || !homeScene || !homeCamera) return;
    const dt = Math.min(0.05, homeClock.getDelta());
    const placing = !!state.homePlacement;

    if (placing) {
      ghostRepeat -= dt;
      const mag = Math.hypot(joystickVec.x, joystickVec.z);
      if (mag > 0.45 && ghostRepeat <= 0) {
        const stepCol = Math.abs(joystickVec.x) > Math.abs(joystickVec.z) ? Math.sign(joystickVec.x) : 0;
        const stepRow = stepCol === 0 ? Math.sign(joystickVec.z) : 0;
        moveHomeGhost(stepCol, stepRow);
        ghostRepeat = 0.16;
      }
      walkAmount += (0 - walkAmount) * Math.min(1, dt * 10);
    } else {
      const mag = Math.min(1, Math.hypot(joystickVec.x, joystickVec.z));
      const pushed = mag > 0.08;
      if (pushed) {
        const inv = 1 / (Math.hypot(joystickVec.x, joystickVec.z) || 1);
        const dirX = joystickVec.x * inv, dirZ = joystickVec.z * inv;
        const pos = homeAvatarRoot.position;
        const step = AVATAR_SPEED * mag * dt;
        pos.x += dirX * step;
        pos.z += dirZ * step;
        // Loose outer net only — the wall colliders do the real containment,
        // same split the other two interiors use. The doorway is the one gap
        // with no collider, so this is what stops the player walking out of it.
        const inner = HOME_WALL_T / 2;
        pos.x = Math.max(-HOME_HALF_W + inner, Math.min(HOME_HALF_W - inner, pos.x));
        pos.z = Math.max(-HOME_HALF_D + inner, Math.min(HOME_HALF_D - AVATAR_RADIUS - 0.12, pos.z));
        resolveHomeCollisions(pos, AVATAR_RADIUS);
        homeAvatarRoot.rotation.y = smoothAngle(homeAvatarRoot.rotation.y, Math.atan2(dirX, dirZ), dt);
      }
      if (pushed) walkPhase += dt * 9;
      walkAmount += ((pushed ? 1 : 0) - walkAmount) * Math.min(1, dt * 10);
    }
    poseWalkCycle(avatarCharacter, walkPhase, walkAmount);

    const followPos = homeAvatarRoot.position;

    // Proximity prompts: the way out, and whichever piece of furniture the
    // player is standing next to (so it can be moved or sold back).
    nearbyHomeExit = !placing &&
      Math.hypot(followPos.x, HOME_HALF_D - followPos.z) < ENTER_RADIUS;
    const exitBtn = document.getElementById('homeExitBtn');
    if (exitBtn) exitBtn.style.display = nearbyHomeExit ? '' : 'none';

    homeRenderer.render(homeScene, homeCamera);
  }
  animate();
}

// ---- Placing furniture ------------------------------------------------
//
// Same buy-then-position flow as the village: the purchase doesn't drop the
// item anywhere, it hands off to the room in placement mode where the player
// drives a ghost around the floor grid and confirms the exact cell. Coins are
// only spent on confirm, so backing out costs nothing.

function buildHomeGhost() {
  if (!homeScene || !state.homePlacement) return;
  if (homeGhostGroup) { homeScene.remove(homeGhostGroup); homeGhostGroup = null; }
  const p = state.homePlacement;
  const item = getHomeItem(p.type);
  const model = HOME_MODELS[p.type];
  if (!item || !model) return;

  const wrapper = new THREE.Group();
  const tile = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x4CAF6D, transparent: true, opacity: 0.42, depthWrite: false })
  );
  tile.rotation.x = -Math.PI / 2;
  tile.position.y = 0.02;
  tile.name = 'ghostTile';
  wrapper.add(tile);

  const preview = model.build();
  preview.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity = 0.55;
    o.material.depthWrite = false;
  });
  preview.name = 'ghostModel';
  wrapper.add(preview);

  homeGhostGroup = wrapper;
  homeScene.add(wrapper);
  updateHomeGhost();
}

function updateHomeGhost() {
  const p = state.homePlacement;
  if (!p || !homeGhostGroup) return;
  const item = getHomeItem(p.type);
  if (!item) return;
  const turned = Math.abs(Math.sin(p.rot || 0)) > 0.5;
  const w = turned ? item.h : item.w;
  const h = turned ? item.w : item.h;
  // A rotated item is moved as a rotated footprint, so validity is checked
  // against the shape actually being dropped, not the catalogue's shape.
  const occupancy = homeOccupancy(p.uid || null);
  p.valid = homeSpotFree(occupancy, p.col, p.row, w, h);

  const center = homeFootprintCenter(p.col, p.row, w, h);
  homeGhostGroup.position.set(center.x, 0, center.z);
  const tile = homeGhostGroup.getObjectByName('ghostTile');
  if (tile) {
    tile.scale.set(w * HOME_CELL, h * HOME_CELL, 1);
    tile.material.color.set(p.valid ? 0x4CAF6D : 0xE0524A);
  }
  const preview = homeGhostGroup.getObjectByName('ghostModel');
  if (preview) preview.rotation.y = p.rot || 0;

  const confirmBtn = document.getElementById('homeConfirmBtn');
  if (confirmBtn) confirmBtn.disabled = !p.valid;
}

function moveHomeGhost(dCol, dRow) {
  const p = state.homePlacement;
  if (!p) return;
  const item = getHomeItem(p.type);
  if (!item) return;
  const turned = Math.abs(Math.sin(p.rot || 0)) > 0.5;
  const w = turned ? item.h : item.w;
  const h = turned ? item.w : item.h;
  p.col = Math.max(0, Math.min(HOME_COLS - w, p.col + dCol));
  p.row = Math.max(0, Math.min(HOME_ROWS - h, p.row + dRow));
  updateHomeGhost();
}

function rotateHomeGhost() {
  const p = state.homePlacement;
  if (!p) return;
  const item = getHomeItem(p.type);
  if (!item) return;
  p.rot = ((p.rot || 0) + Math.PI / 2) % (Math.PI * 2);
  const turned = Math.abs(Math.sin(p.rot)) > 0.5;
  const w = turned ? item.h : item.w;
  const h = turned ? item.w : item.h;
  // Turning near an edge can push the footprint off the grid, so pull it back
  // in rather than refusing the rotation.
  p.col = Math.max(0, Math.min(HOME_COLS - w, p.col));
  p.row = Math.max(0, Math.min(HOME_ROWS - h, p.row));
  updateHomeGhost();
}

function startHomePlacement(type, uid) {
  const item = getHomeItem(type);
  if (!item) return;
  const existing = uid ? homeState().items.find((i) => i.uid === uid) : null;
  const occupancy = homeOccupancy(uid || null);
  const spot = existing
    ? { col: existing.col, row: existing.row }
    : homeFindFreeSpot(occupancy, item.w, item.h);
  if (!spot) { alert(`There's no room left in here for a ${item.name}.`); return; }
  state.homePlacement = {
    type, uid: uid || null, col: spot.col, row: spot.row,
    rot: existing ? (existing.rot || 0) : 0, valid: true,
    paid: !!existing,   // moving something already owned costs nothing
  };
  saveState();
  goTo('homeInterior');
}

function confirmHomePlacement() {
  const p = state.homePlacement;
  if (!p || !p.valid) return;
  const item = getHomeItem(p.type);
  if (!item) return;
  if (!p.paid && !canAfford(item.cost)) return;
  if (!p.paid) spendCoins(item.cost);
  const home = homeState();
  if (p.uid) {
    const existing = home.items.find((i) => i.uid === p.uid);
    if (existing) { existing.col = p.col; existing.row = p.row; existing.rot = p.rot || 0; }
  } else {
    home.items.push({ uid: `${p.type}-${Date.now()}-${home.items.length}`, type: p.type, col: p.col, row: p.row, rot: p.rot || 0 });
  }
  state.homePlacement = null;
  saveState();
  render();
}

function cancelHomePlacement() {
  state.homePlacement = null;
  saveState();
  render();
}



// Takes a piece back out of the room and returns what it cost. Full refund
// on purpose: there is no exploit in it — buying and putting away at the same
// price nets zero — and a decorating screen where mistakes cost money is one
// people stop touching.
function putAwayHomeItem(uid) {
  const home = homeState();
  const idx = home.items.findIndex((i) => i.uid === uid);
  if (idx === -1) return;
  const item = getHomeItem(home.items[idx].type);
  if (item && !state.devMode) state.coins += item.cost;
  home.items.splice(idx, 1);
  saveState();
  render();
}

function setHomeColor(kind, hex) {
  const home = homeState();
  if (kind === 'wall') home.wall = hex; else home.floor = hex;
  saveState();
  render();
}

function buyHomeItem(id) {
  const item = getHomeItem(id);
  if (!item || !canAfford(item.cost)) {
    if (item) alert(`You need ${item.cost} 🪙 for a ${item.name}.`);
    return;
  }
  startHomePlacement(id, null);
}

// ---- Getting in and out ------------------------------------------------

function getPlayerHouseCenter() {
  return footprintCenterWorld(HOUSE_ROW_COL, HOUSE_ROW_ROW, 3, 3);
}

// The player's own front step, just outside the house collider's south edge —
// the same shape as getTownHallDoorPoint().
function getPlayerHouseDoorPoint() {
  const c = getPlayerHouseCenter();
  return { x: c.x, z: c.z + HOUSE_COLLIDE.hh };
}

function enterHome() {
  if (!nearbyPlayerHouseDoor || state.placement || activeDialogue || avatarSitting || avatarSitTarget) return;
  playScreenTransition('Going inside…', () => goTo('homeInterior'));
}

// The catalogue is always opened from inside the house, so "Back inside" is a
// step back, not a step forward. Pushing the shop onto history here would make
// walking out the front door land in the shop again instead of in town.
function backInsideHome() {
  if (state.history[state.history.length - 1] === 'homeInterior') goBack();
  else goTo('homeInterior');
}

function exitHome() {
  if (!nearbyHomeExit) return;
  playScreenTransition('Heading out…', () => {
    state.homePlacement = null;
    goBack();
  });
}

// ---- Screens -----------------------------------------------------------

function screenHomeInterior() {
  const placing = state.homePlacement;
  const item = placing ? getHomeItem(placing.type) : null;
  return `
    <div class="screen village-screen">
      <div class="village-plot" style="position:relative; padding:0;">
        <div id="homeScene" style="position:absolute; inset:0;"></div>
        <div class="village-overlay-top">
          <div class="chip-row">
            <span class="chip on">My home</span>
          </div>
        </div>
        <div class="joystick-base" id="homeJoystickBase">
          <div class="joystick-knob" id="homeJoystickKnob"></div>
        </div>
        ${placing ? `
          <div class="home-place-hint">Nudge the stick to move the ${escapeHtml(item ? item.name.toLowerCase() : 'item')}</div>
          <div class="home-btn-stack">
            <button class="talk-btn home-btn" onclick="rotateHomeGhost()">Turn</button>
            <button class="talk-btn home-btn" id="homeConfirmBtn" onclick="confirmHomePlacement()">Place</button>
            <button class="talk-btn home-btn ghost" onclick="cancelHomePlacement()">Cancel</button>
          </div>
        ` : `
          <div class="home-btn-stack">
            <button class="talk-btn home-btn" id="homeExitBtn" style="display:none;" onclick="exitHome()">Exit</button>
          </div>
        `}
      </div>
      ${renderNavbar('village')}
    </div>
  `;
}

function screenHomeShop() {
  const valid = ['buy', 'placed', 'paint'];
  const tab = valid.includes(state.homeShopTab) ? state.homeShopTab : 'buy';
  const home = homeState();

  const buyBody = `<div class="grid2">
    ${HOME_ITEMS.map((it) => {
      const owned = home.items.filter((p) => p.type === it.id).length;
      const afford = canAfford(it.cost);
      return `
        <div class="card structure-card ${afford ? '' : 'locked'}" ${afford ? `onclick="buyHomeItem('${it.id}')"` : ''}>
          <div class="structure-preview" data-home-canvas="${it.id}"></div>
          <div class="txt tiny">${it.name}${owned ? ` <span class="soft">×${owned}</span>` : ''}</div>
          <div class="txt soft tiny">${it.cost} 🪙</div>
        </div>`;
    }).join('')}
  </div>`;

  // Everything currently in the room, with the two things you can do to it.
  // This lives here rather than on a walk-up prompt inside the room so the
  // whole of "what's in my house" is one list you can read at a glance.
  const placedBody = home.items.length
    ? home.items.map((p) => {
        const it = getHomeItem(p.type);
        if (!it) return '';
        return `
          <div class="card home-row">
            <div class="txt tiny home-row-name">${it.name}</div>
            <button class="mini-btn" onclick="startHomePlacement('${p.type}','${p.uid}')">Move</button>
            <button class="mini-btn ghost" onclick="putAwayHomeItem('${p.uid}')">Put away</button>
          </div>`;
      }).join('')
    : `<div class="txt soft tiny">Nothing in here yet — pick something from the Buy tab.</div>`;

  const paintBody = `
    <div class="section-label">Walls</div>
    <div class="swatch-grid">${HOME_WALL_COLORS.map((c) => `
      <div class="swatch ${home.wall === c ? 'on' : ''}" style="background:${c};" onclick="setHomeColor('wall','${c}')"></div>
    `).join('')}</div>
    <div class="section-label">Floor</div>
    <div class="swatch-grid">${HOME_FLOOR_COLORS.map((c) => `
      <div class="swatch ${home.floor === c ? 'on' : ''}" style="background:${c};" onclick="setHomeColor('floor','${c}')"></div>
    `).join('')}</div>
    <div class="txt soft tiny" style="margin-top:10px;">Painting is free — change it as often as you like.</div>`;

  const body = tab === 'buy' ? buyBody : tab === 'placed' ? placedBody : paintBody;

  return `
    <div class="screen">
      <div class="txt" style="font-size:15px;">Your home</div>
      <div class="txt soft tiny">You have 🪙 ${coinsLabel()}</div>
      <div class="tab-row" style="margin-top:10px;">
        <div class="tab ${tab === 'buy' ? 'on' : ''}" onclick="setHomeShopTab('buy')">Buy</div>
        <div class="tab ${tab === 'placed' ? 'on' : ''}" onclick="setHomeShopTab('placed')">Placed${home.items.length ? ` (${home.items.length})` : ''}</div>
        <div class="tab ${tab === 'paint' ? 'on' : ''}" onclick="setHomeShopTab('paint')">Paint</div>
      </div>
      <div style="margin-top:12px;">${body}</div>
      <div class="spacer"></div>
      <button class="btn" onclick="backInsideHome()">Back inside</button>
      ${renderNavbar('homeShop')}
    </div>
  `;
}

function setHomeShopTab(tab) {
  state.homeShopTab = tab;
  saveState();
  render();
}

// Card previews, same approach as the structure shop: one small renderer per
// card at a fixed internal resolution, drawn once — these are still lifes, so
// there's nothing to animate.
let homeShopRenderers = [];

function teardownHomeShopScene() {
  homeShopRenderers.forEach((r) => {
    r.dispose();
    if (r.forceContextLoss) r.forceContextLoss();
    if (r.domElement && r.domElement.parentNode) r.domElement.parentNode.removeChild(r.domElement);
  });
  homeShopRenderers = [];
}

function initHomeShopScene() {
  teardownHomeShopScene();
  if (typeof THREE === 'undefined') return;
  HOME_ITEMS.forEach((it) => {
    const holder = document.querySelector(`[data-home-canvas="${it.id}"]`);
    const model = HOME_MODELS[it.id];
    if (!holder || !model) return;
    const previewW = 220, previewH = 120;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, previewW / previewH, 0.1, 20);
    // Framing scales with the item's own footprint so a bed and a plant pot
    // both fill roughly the same share of their card.
    const reach = Math.max(it.w, it.h) * HOME_CELL;
    const camScale = 0.85 + reach * 0.55;
    camera.position.set(1.15 * camScale, 1.0 * camScale, 1.35 * camScale);
    camera.lookAt(0, 0.28, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(previewW, previewH, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    holder.appendChild(renderer.domElement);
    homeShopRenderers.push(renderer);

    scene.add(new THREE.HemisphereLight(0xFFF1DC, 0xB09070, 0.95));
    const sun = new THREE.DirectionalLight(0xFFE9C4, 0.85);
    sun.position.set(2.2, 3.6, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    scene.add(sun);

    // A scrap of the player's own floor colour under each piece, so the
    // catalogue previews the item in the room it's actually going into.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(reach * 0.95 + 0.35, 32),
      new THREE.MeshStandardMaterial({ color: homeState().floor, roughness: 0.9 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.receiveShadow = true;
    scene.add(disc);
    scene.add(model.build());
    renderer.render(scene, camera);
  });
}

const SCREENS = {
  welcome: screenWelcome,
  returningWelcome: screenReturningWelcome,
  name: screenName,
  character: screenCharacter,
  triggers: screenTriggers,
  villageName: screenVillageName,
  howItWorks: screenHowItWorks,
  emptyVillage: screenEmptyVillage,
  quests: screenQuests,
  questDetail: screenQuestDetail,
  verify: screenVerify,
  reward: screenReward,
  village: screenVillage,
  structureShop: screenStructureShop,
  townHallInterior: screenTownHallInterior,
  partyHallInterior: screenPartyHallInterior,
  homeInterior: screenHomeInterior,
  homeShop: screenHomeShop,
  settings: screenSettings,
  journal: screenJournal,
  journalEntry: screenJournalEntry,
};

function render() {
  const app = document.getElementById('app');
  const fn = SCREENS[state.screen] || screenWelcome;
  app.innerHTML = fn();
  if (state.screen === 'welcome' || state.screen === 'returningWelcome') {
    initWelcomeScene();
  } else {
    teardownWelcomeScene();
  }
  if (state.screen === 'character') {
    initCharacterScene();
  } else {
    teardownCharacterScene();
  }
  if (state.screen === 'village') {
    initVillageScene();
  } else {
    teardownVillageScene();
  }
  if (state.screen === 'emptyVillage') {
    initEmptyVillagePreviewScene();
  } else {
    teardownEmptyVillagePreview();
  }
  if (state.screen === 'structureShop') {
    initStructureShopScene();
  } else {
    teardownStructureShopScene();
  }
  if (state.screen === 'townHallInterior') {
    initTownHallInteriorScene();
  } else {
    teardownTownHallInteriorScene();
  }
  if (state.screen === 'partyHallInterior') {
    initPartyHallInteriorScene();
  } else {
    teardownPartyHallInteriorScene();
  }
  if (state.screen === 'homeInterior') {
    initHomeInteriorScene();
  } else {
    teardownHomeInteriorScene();
  }
  if (state.screen === 'homeShop') {
    initHomeShopScene();
  } else {
    teardownHomeShopScene();
  }
  renderDevBadge();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// The app fills the browser window now rather than a fixed 375x720 frame, so
// the window can change size underneath a live 3D view. Every renderer is
// sized once when its scene is built — which was safe while the frame could
// never change — so each one has to be re-fitted here instead.
let viewportResizeTimer = null;
function handleViewportResize() {
  clearTimeout(viewportResizeTimer);
  viewportResizeTimer = setTimeout(() => {
    const views = [
      ['villageScene', villageRenderer, villageCamera],
      ['characterCanvas', charRenderer, charCamera],
      ['townHallScene', hallRenderer, hallCamera],
      ['partyHallScene', partyRenderer, partyCamera],
      ['homeScene', homeRenderer, homeCamera],
    ];
    let refitted = false;
    views.forEach(([id, renderer, camera]) => {
      if (!renderer || !camera) return;
      const holder = document.getElementById(id);
      if (!holder || !holder.clientWidth || !holder.clientHeight) return;
      renderer.setSize(holder.clientWidth, holder.clientHeight);
      if (id === 'homeScene') {
        fitHomeCamera(camera, holder.clientWidth / holder.clientHeight);
      } else {
        camera.aspect = holder.clientWidth / holder.clientHeight;
        camera.updateProjectionMatrix();
      }
      refitted = true;
    });
    // The welcome grove and the empty-village preview keep their camera in
    // their own closure, so there is nothing to re-fit from out here. Both are
    // pure scenery with no player position to lose, so rebuilding them at the
    // new size is the cheap and correct fix rather than plumbing those
    // cameras out to module scope.
    if (!refitted && ['welcome', 'returningWelcome', 'emptyVillage'].includes(state.screen)) {
      render();
    }
  }, 150);
}
window.addEventListener('resize', handleViewportResize);

applyDevModeFromUrl();
state.screen = state.hasOnboarded ? 'returningWelcome' : 'welcome';
state.history = [];
render();
