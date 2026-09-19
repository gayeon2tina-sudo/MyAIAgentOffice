const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const PORT = 8787;
const SETTINGS_DEFAULTS = {
  remindersEnabled: false,
  intervalHours: 2,
  activeStart: '08:00',
  activeEnd: '22:00',
  lastReminderAt: 0,
  launchAtLogin: false
};

// A second launch (double-clicking the app again, or a login-item start
// while it's already running) should focus the existing window, not fight
// the first instance over port 8787 or open a duplicate tray icon.
const gotLock = app.requestSingleInstanceLock();
if(!gotLock){
  app.quit();
  return;
}

var mainWindow = null;
var tray = null;
var isQuitting = false;
var reminderTimer = null;

/* ===================== Settings (userData/settings.json) =====================
   The desktop app's own source of truth for reminders + launch-at-login —
   read directly by the background timer below, which has to work with no
   renderer/window open at all, so it can't depend on localStorage. The
   in-app Reminders modal (daily_hq.html) mirrors this over IPC; see
   electron/preload.js and the small hooks added in daily_hq.html. */

function settingsPath(){ return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings(){
  try{
    var raw = fs.readFileSync(settingsPath(), 'utf8');
    return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(raw));
  } catch(e){
    return Object.assign({}, SETTINGS_DEFAULTS);
  }
}
function saveSettings(s){
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}
var settings = null; // populated in app.whenReady

/* ===================== Embedded local server =====================
   Same server.js the plain browser/GitHub-Pages setup already relies on
   for Radio to Base and Claude Code task logging — started in-process here
   instead of requiring a separate `npm run server` in a terminal. Its data
   directory moves to userData so the desktop app's task history survives
   app updates. */

function startEmbeddedServer(){
  process.env.DAILYHQ_DATA_DIR = path.join(app.getPath('userData'), 'data');
  var serverPath = path.join(__dirname, '..', 'server.js');
  require(serverPath).startServer(PORT);
}

/* ===================== Window ===================== */

function createWindow(){
  if(mainWindow){
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    minWidth: 900,
    minHeight: 700,
    title: 'BIG GY INC',
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadURL('http://localhost:' + PORT + '/daily_hq.html');

  // Closing the window minimizes to the tray instead of quitting — the app
  // keeps running in the background (reminders keep firing) until "Quit"
  // is chosen from the tray menu specifically.
  mainWindow.on('close', function(event){
    if(isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', function(){ mainWindow = null; });
}

/* ===================== Tray ===================== */

function trayIcon(){
  return nativeImage.createFromPath(path.join(__dirname, 'trayIconTemplate.png'));
}

function rebuildTrayMenu(){
  if(!tray) return;
  var menu = Menu.buildFromTemplate([
    { label: 'Open BIG GY INC', click: function(){ createWindow(); } },
    {
      label: 'Pause reminders',
      type: 'checkbox',
      checked: !settings.remindersEnabled,
      click: function(item){
        settings.remindersEnabled = !item.checked;
        saveSettings(settings);
        rebuildTrayMenu();
        if(mainWindow) mainWindow.webContents.send('reminder-settings-changed', settings);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: function(){
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function createTray(){
  tray = new Tray(trayIcon());
  tray.setToolTip('BIG GY INC — Daily HQ');
  rebuildTrayMenu();
  // Left-click on Windows/Linux (macOS Tray click already opens the menu on
  // most versions, but this makes a left-click also restore the window if
  // it's the click that fired rather than the context menu).
  tray.on('click', function(){ createWindow(); });
}

/* ===================== Background reminders ===================== */

// A tiny, deliberately independent copy of a few rooms' flavor — matching
// the existing project convention (server.js's own CATEGORY_KEYWORDS
// comment) of keeping this kind of heuristic duplicated rather than
// reaching into daily_hq.html's inline script from Node. Only used for a
// bit of personality in the notification body; the room list itself
// doesn't need to be exhaustive since any category not listed here still
// gets a plain, still-genuine message.
var REMINDER_FLAVOR = {
  job: 'Scout and Editor are still waiting on you.',
  learning: "Compiler's got the laptop open whenever you are.",
  portfolio: 'Builder left a beam half-placed.',
  backpack: 'Storyteller has an idea sitting there.',
  budget: 'Ledger left the books open.',
  health: 'Stride is stretching, no rush.'
};

function todayDateStr(){
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function timeInRange(now, startStr, endStr){
  var mins = now.getHours()*60 + now.getMinutes();
  var sp = startStr.split(':').map(Number), ep = endStr.split(':').map(Number);
  var start = sp[0]*60+sp[1], end = ep[0]*60+ep[1];
  if(start === end) return true;
  if(start < end) return mins >= start && mins < end;
  return mins >= start || mins < end; // wraps past midnight
}
function readTodayTasks(){
  try{
    var file = path.join(process.env.DAILYHQ_DATA_DIR, todayDateStr() + '.json');
    var day = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(day.tasks) ? day.tasks : [];
  } catch(e){
    return [];
  }
}

function maybeSendReminder(){
  settings = loadSettings();
  if(!settings.remindersEnabled) return;
  if(!timeInRange(new Date(), settings.activeStart, settings.activeEnd)) return;
  var elapsedMs = Date.now() - (settings.lastReminderAt || 0);
  if(elapsedMs < settings.intervalHours*3600*1000) return;

  var tasks = readTodayTasks();
  var undone = tasks.filter(function(t){ return !t.done; });
  if(undone.length === 0) return;

  // Route the click to whichever category has the most open tasks.
  var counts = {};
  undone.forEach(function(t){ counts[t.category] = (counts[t.category]||0) + 1; });
  var topCat = Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a]; })[0];
  var flavor = REMINDER_FLAVOR[topCat];
  var body = undone.length + ' task' + (undone.length===1?'':'s') + ' still open today.' + (flavor ? ' ' + flavor : '');

  var n = new Notification({
    title: 'BIG GY INC',
    body: body,
    icon: path.join(__dirname, '..', 'icons', 'icon-192.png')
  });
  n.on('click', function(){
    createWindow();
    if(mainWindow){ mainWindow.show(); mainWindow.focus(); }
    if(mainWindow) mainWindow.webContents.send('open-category', topCat);
  });
  n.show();

  settings.lastReminderAt = Date.now();
  saveSettings(settings);
}

function startReminderTimer(){
  if(reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(maybeSendReminder, 5*60*1000);
  maybeSendReminder();
}

/* ===================== IPC ===================== */

ipcMain.handle('get-settings', function(){ return loadSettings(); });
ipcMain.on('sync-reminder-settings', function(event, s){
  // The renderer's existing Reminders modal is still the primary UI for
  // these — this just mirrors its saves into the file the background timer
  // actually reads, so "on/off", interval, and quiet hours all apply even
  // with no window open.
  settings = Object.assign({}, loadSettings(), {
    remindersEnabled: !!s.enabled,
    intervalHours: s.intervalHours,
    activeStart: s.activeStart,
    activeEnd: s.activeEnd
  });
  saveSettings(settings);
  if(tray) rebuildTrayMenu();
});
ipcMain.handle('get-launch-at-login', function(){ return loadSettings().launchAtLogin; });
ipcMain.on('set-launch-at-login', function(event, val){
  settings = Object.assign({}, loadSettings(), { launchAtLogin: !!val });
  saveSettings(settings);
  app.setLoginItemSettings({ openAtLogin: !!val, openAsHidden: true });
});

/* ===================== App lifecycle ===================== */

app.on('second-instance', function(){ createWindow(); });

app.whenReady().then(function(){
  settings = loadSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, openAsHidden: true });
  startEmbeddedServer();
  createTray();
  createWindow();
  startReminderTimer();
});

app.on('window-all-closed', function(){
  // Intentionally a no-op: the app lives in the tray with the window
  // closed. Only the tray's "Quit" (which sets isQuitting and calls
  // app.quit()) actually ends the process.
});
app.on('before-quit', function(){ isQuitting = true; });
app.on('activate', function(){ createWindow(); });
