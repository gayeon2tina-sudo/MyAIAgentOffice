const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8787;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));
// /api/day is polled repeatedly (boot + every window focus) and must always
// reflect the file on disk, never a validator-based reuse of an old body.
// Disabled app-wide rather than per-route, since Express adds the ETag
// inside res.send() itself, after route code runs.
app.disable('etag');

/* ===================== Day log file storage =====================
   Mirrors the client's localStorage day-object shape exactly (see
   defaultDay() in daily_hq.html) so the two stay interchangeable. This
   is what lets a Claude Code session append a real task to today's log
   by writing a file, not just something noted in chat — and it only
   exists when this server is running; the static GitHub Pages build has
   no backend and falls back to localStorage alone. */

// Overridable so the Electron desktop app can point this at its userData
// directory (survives app updates, sits outside the installed bundle)
// instead of a folder next to the source — `npm run server` is unaffected
// and keeps using ./data exactly as before.
const DATA_DIR = process.env.DAILYHQ_DATA_DIR || path.join(__dirname, 'data');

function todayStr(){
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function isValidDateStr(s){ return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function dayFilePath(dateStr){ return path.join(DATA_DIR, dateStr + '.json'); }
function defaultDay(dateStr){ return { date: dateStr, tasks: [], outreach: {}, note: '', reviewed: false }; }
function makeId(prefix){ return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7); }

function loadDayFile(dateStr){
  try{
    var raw = fs.readFileSync(dayFilePath(dateStr), 'utf8');
    var day = JSON.parse(raw);
    if(!Array.isArray(day.tasks)) day.tasks = [];
    migrateJobCvMerge(day);
    migratePortfolioBackpackMerge(day);
    return day;
  } catch(e){
    return defaultDay(dateStr);
  }
}

// Mirrors the same migration in daily_hq.html's loadDay(): 'cv' was its own
// category before Job Hunt + CV & Applications merged, now it's the
// "Applications" sub-section of 'job' — remap on read so old files on disk
// still make sense instead of referencing a category that no longer exists.
function migrateJobCvMerge(day){
  day.tasks.forEach(function(t){
    if(t.category === 'cv'){
      t.category = 'job';
      t.sub = 'applications';
    } else if(t.category === 'job' && !t.sub){
      t.sub = detectJobSub(t.text);
    }
  });
}
// Same pattern for the Content Building merge: 'backpack' was its own
// category before, now it's the "Content" sub-section of 'portfolio'.
function migratePortfolioBackpackMerge(day){
  day.tasks.forEach(function(t){
    if(t.category === 'backpack'){
      t.category = 'portfolio';
      t.sub = 'content';
    } else if(t.category === 'portfolio' && !t.sub){
      t.sub = 'portfolio';
    }
  });
}
function saveDayFile(dateStr, day){
  // Checked on every write, not once at server start: the directory being
  // missing at write time (deleted, a fresh checkout, anything) should
  // self-heal instead of taking down every subsequent log-task/save until
  // the process is restarted. mkdirSync with recursive:true is a cheap
  // no-op when the directory already exists.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(dayFilePath(dateStr), JSON.stringify(day, null, 2));
}

// Same keyword lists as CATEGORIES in daily_hq.html, kept independent on
// purpose: this is only a fallback for when a caller doesn't pass a
// category explicitly. A Claude Code session acting on a real request
// ("log that I applied to the Google PM role") should read the sentence
// and pass the right category itself — it has context this heuristic
// doesn't.
// Job Hunt and CV & Applications are one category now ('job'); the old
// 'cv' keywords still count toward it, just via JOB_SUB_KEYWORDS below,
// which additionally decides its "Outreach & Leads" vs "Applications"
// sub-section for display. Same for 'portfolio' (Content Building), whose
// old 'backpack' keywords now decide the "Portfolio" vs "Content" sub via
// CONTENT_SUB_KEYWORDS.
var CATEGORY_KEYWORDS = {
  job: ['job','jobs','posting','postings','role','roles','shortlist','linkedin','indeed','recruiter','apply for','pm role','pmm role','opening','openings','lead','leads','cv','resume','résumé','cover letter','tailor','application draft','submit application','cover ltr','applied','application'],
  learning: ['certification','certified','course','learn','learning','build','side project','app','anthropic','skill','study'],
  portfolio: ['portfolio','webflow','lovable','site','website','page copy','landing page','backpack','blog','post idea','content','draft post','newsletter','write about','write a post'],
  // Broadened beyond pure finance to general life upkeep, per the Life
  // Admin rename — appointments/paperwork/errands, not just money.
  budget: ['budget','runway','rent','lease','seattle','move','moving','expenses','savings','spreadsheet','bank','appointment','paperwork','errand','errands','insurance','doctor','dentist','dmv','renew','renewal','license','passport','taxes','bills','mail','forms','registration'],
  health: ['run','running','yoga','workout','gym','walk','stretch','exercise','swim','bike','pilates','lift']
};
var VALID_CATEGORIES = Object.keys(CATEGORY_KEYWORDS);
function detectCategory(text){
  var lower = (text || '').toLowerCase();
  var best = null, bestScore = 0;
  VALID_CATEGORIES.forEach(function(cat){
    var score = 0;
    CATEGORY_KEYWORDS[cat].forEach(function(kw){ if(lower.indexOf(kw) !== -1) score++; });
    if(score > bestScore){ bestScore = score; best = cat; }
  });
  return best;
}

var JOB_SUB_KEYWORDS = {
  applications: ['cv','resume','résumé','cover letter','tailor','application draft','submit application','cover ltr','applied','application'],
  outreach: ['job','jobs','posting','postings','role','roles','shortlist','linkedin','indeed','recruiter','apply for','pm role','pmm role','opening','openings','lead','leads']
};
function detectJobSub(text){
  var lower = (text || '').toLowerCase();
  // "Applied to the Google PM role" contains both an unambiguous Applications
  // signal ("applied") and an Outreach & Leads one ("pm role") — plain
  // keyword-count scoring ties 1-to-1 and silently falls to whichever side
  // happens to be checked first. An explicit completed-application word is
  // decisive regardless of what else is in the sentence.
  var APPLICATION_ACTION_WORDS = ['applied','application','submitted my application','sent my application'];
  if(APPLICATION_ACTION_WORDS.some(function(w){ return lower.indexOf(w) !== -1; })) return 'applications';
  var appScore = 0, outScore = 0;
  JOB_SUB_KEYWORDS.applications.forEach(function(kw){ if(lower.indexOf(kw) !== -1) appScore++; });
  JOB_SUB_KEYWORDS.outreach.forEach(function(kw){ if(lower.indexOf(kw) !== -1) outScore++; });
  return appScore > outScore ? 'applications' : 'outreach';
}

var CONTENT_SUB_KEYWORDS = {
  portfolio: ['portfolio','webflow','lovable','site','website','page copy','landing page'],
  content: ['backpack','blog','post idea','content','draft post','newsletter','write about','write a post']
};
function detectContentSub(text){
  var lower = (text || '').toLowerCase();
  var portScore = 0, contScore = 0;
  CONTENT_SUB_KEYWORDS.portfolio.forEach(function(kw){ if(lower.indexOf(kw) !== -1) portScore++; });
  CONTENT_SUB_KEYWORDS.content.forEach(function(kw){ if(lower.indexOf(kw) !== -1) contScore++; });
  return contScore > portScore ? 'content' : 'portfolio';
}

app.get('/api/day', function(req, res){
  var date = isValidDateStr(req.query.date) ? req.query.date : todayStr();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  return res.json({ ok:true, day: loadDayFile(date) });
});

app.put('/api/day', function(req, res){
  var day = req.body;
  if(!day || !isValidDateStr(day.date)){
    return res.status(400).json({ ok:false, error:'Body must be a day object with a valid YYYY-MM-DD date field.' });
  }
  if(!Array.isArray(day.tasks)){
    return res.status(400).json({ ok:false, error:'Body must include a tasks array.' });
  }
  saveDayFile(day.date, day);
  return res.json({ ok:true, day: day });
});

app.post('/api/log-task', function(req, res){
  var text = (req.body && req.body.text || '').trim();
  if(!text){
    return res.status(400).json({ ok:false, error:'No task text provided.' });
  }
  if(text.length > 500){
    return res.status(400).json({ ok:false, error:'That task text is too long (max 500 characters).' });
  }
  var date = isValidDateStr(req.body.date) ? req.body.date : todayStr();
  var category = req.body.category;
  if(category && VALID_CATEGORIES.indexOf(category) === -1){
    return res.status(400).json({ ok:false, error:'Unknown category "' + category + '". Must be one of: ' + VALID_CATEGORIES.join(', ') + '.' });
  }
  if(!category){
    category = detectCategory(text);
    if(!category){
      return res.status(400).json({ ok:false, error:'Could not guess a category for that task — pass one explicitly. Must be one of: ' + VALID_CATEGORIES.join(', ') + '.' });
    }
  }
  var milestone = !!(req.body && req.body.milestone);
  // Defaults to already-done: this endpoint is for logging something that
  // already happened ("log that I applied..."), not adding a to-do. Pass
  // done:false explicitly if that's genuinely the intent.
  var done = req.body && typeof req.body.done === 'boolean' ? req.body.done : true;

  var day = loadDayFile(date);
  var task = {
    id: makeId('t'),
    text: text,
    category: category,
    done: done,
    milestone: milestone,
    recurringId: null,
    createdAt: Date.now(),
    source: 'claude-code'
  };
  if(category === 'job') task.sub = req.body && (req.body.sub === 'applications' || req.body.sub === 'outreach') ? req.body.sub : detectJobSub(text);
  else if(category === 'portfolio') task.sub = req.body && (req.body.sub === 'portfolio' || req.body.sub === 'content') ? req.body.sub : detectContentSub(text);
  day.tasks.push(task);
  saveDayFile(date, day);
  return res.json({ ok:true, task: task, day: day });
});

const SYSTEM_PROMPT = [
  'You are Base, a warm, direct radio operator for BIG GY INC\'s arctic outpost — GaYeon\'s personal Daily HQ app.',
  'Answer briefly and practically — a few sentences to a short paragraph, not an essay.',
  'No guilt language, no generic productivity platitudes. Be specific to what she gave you.',
  'If she asks something the given context can\'t answer, say so plainly rather than guessing.'
].join(' ');

const DISALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,NotebookEdit,Agent,TaskCreate';

function buildPrompt(question, goals, todayTasks){
  var parts = [];
  if(Array.isArray(goals) && goals.length){
    parts.push('Her three yearly goals:');
    goals.forEach(function(g){
      parts.push('- ' + g.name + (g.onTrack ? ' (on track this month: ' + g.onTrack + ')' : ' (no "on track" note set yet)'));
    });
  }
  if(Array.isArray(todayTasks) && todayTasks.length){
    parts.push('\nToday\'s task list:');
    todayTasks.forEach(function(t){
      parts.push('- [' + (t.done ? 'done' : 'not done') + '] ' + t.text + ' (' + t.category + ')' + (t.milestone ? ' — milestone' : ''));
    });
  } else {
    parts.push('\nNo tasks logged yet today.');
  }
  parts.push('\nHer question: ' + question);
  return parts.join('\n');
}

// A GUI-launched app (double-clicked from Finder, or Electron's main
// process) doesn't inherit a Terminal's PATH — nvm/homebrew/etc. shims that
// put `claude` on PATH in a shell session are typically missing, so a plain
// execFile('claude', ...) fails with ENOENT there even though the exact
// same command works fine from Terminal. Resolve the real path once via a
// login shell (which sources the user's actual shell profile) and cache it;
// every actual invocation still goes through execFile with an argument
// array, never a shell string, so user-provided prompt text is never at
// risk of shell injection.
var resolvedClaudeBinPromise = null;
function resolveClaudeBin(){
  if(resolvedClaudeBinPromise) return resolvedClaudeBinPromise;
  resolvedClaudeBinPromise = new Promise(function(resolve){
    var shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-lic', 'command -v claude'], { timeout: 10000 }, function(err, stdout){
      var found = (stdout || '').trim().split('\n').pop();
      resolve(found && !err ? found : 'claude'); // fall back to plain PATH lookup
    });
  });
  return resolvedClaudeBinPromise;
}

app.post('/api/ask', function(req, res){
  var question = (req.body && req.body.question || '').trim();
  if(!question){
    return res.status(400).json({ ok:false, error:'No question provided.' });
  }
  if(question.length > 2000){
    return res.status(400).json({ ok:false, error:'That question is too long (max 2000 characters).' });
  }
  var goals = Array.isArray(req.body.goals) ? req.body.goals.slice(0, 10) : [];
  var todayTasks = Array.isArray(req.body.todayTasks) ? req.body.todayTasks.slice(0, 100) : [];
  var prompt = buildPrompt(question, goals, todayTasks);

  var args = [
    '-p',
    '--output-format', 'json',
    '--disallowedTools', DISALLOWED_TOOLS,
    '--append-system-prompt', SYSTEM_PROMPT,
    '--',
    prompt
  ];

  resolveClaudeBin().then(function(claudeBin){
    execFile(claudeBin, args, { timeout: 55000, maxBuffer: 10 * 1024 * 1024 }, function(err, stdout, stderr){
      if(err){
        if(err.code === 'ENOENT'){
          return res.status(500).json({ ok:false, error:'The "claude" CLI isn\'t installed or not on PATH on this machine. Install Claude Code CLI to use this feature.' });
        }
        if(err.killed || err.signal){
          return res.status(504).json({ ok:false, error:'The request to Claude timed out.' });
        }
        var trimmedStderr = (stderr || '').trim();
        return res.status(500).json({ ok:false, error: trimmedStderr ? ('Claude CLI error: ' + trimmedStderr.slice(0, 500)) : ('Claude CLI exited with an error (code ' + err.code + ').') });
      }
      var parsed;
      try{
        parsed = JSON.parse(stdout);
      } catch(parseErr){
        return res.status(500).json({ ok:false, error:'Got an unreadable response from the Claude CLI.' });
      }
      if(parsed.is_error){
        return res.status(500).json({ ok:false, error: parsed.result || 'Claude CLI reported an error.' });
      }
      return res.json({ ok:true, answer: parsed.result || '(empty response)' });
    });
  });
});

// Exported so the Electron main process can start this same server
// in-process (folding the "local server" requirement into the desktop app
// itself) instead of every caller needing its own `node server.js` in a
// terminal. Only auto-starts on `node server.js` / `npm run server` — a
// require() from Electron gets the app instance without a second listener.
function startServer(port){
  return app.listen(port || PORT, function(){
    console.log('BIG GY INC Daily HQ server running at http://localhost:' + (port || PORT) + '/daily_hq.html');
  });
}
module.exports = { app: app, startServer: startServer };

if(require.main === module){
  startServer(PORT);
}
