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

const DATA_DIR = path.join(__dirname, 'data');

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
    return day;
  } catch(e){
    return defaultDay(dateStr);
  }
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
var CATEGORY_KEYWORDS = {
  job: ['job','jobs','posting','postings','role','roles','shortlist','linkedin','indeed','recruiter','apply for','pm role','pmm role','opening','openings','lead','leads'],
  cv: ['cv','resume','résumé','cover letter','tailor','application draft','submit application','cover ltr','applied','application'],
  portfolio: ['portfolio','webflow','lovable','site','website','page copy','landing page'],
  backpack: ['backpack','blog','post idea','content','draft post','newsletter','write about','write a post'],
  budget: ['budget','runway','rent','lease','seattle','move','moving','expenses','savings','spreadsheet','bank'],
  health: ['run','running','yoga','workout','gym','walk','stretch','exercise','swim','bike','pilates','lift']
};
var VALID_CATEGORIES = Object.keys(CATEGORY_KEYWORDS);
function detectCategory(text){
  var lower = (text || '').toLowerCase();
  // "Applied to the Google PM role" contains both an unambiguous CV & Applications
  // signal ("applied") and a Job Search one ("pm role") — plain keyword-count
  // scoring ties 1-to-1 and silently falls to whichever category happens to be
  // listed first. An explicit completed-application word is decisive regardless
  // of what else is in the sentence, so it's checked before generic scoring.
  var APPLICATION_ACTION_WORDS = ['applied','application','submitted my application','sent my application'];
  if(APPLICATION_ACTION_WORDS.some(function(w){ return lower.indexOf(w) !== -1; })) return 'cv';

  var best = null, bestScore = 0;
  VALID_CATEGORIES.forEach(function(cat){
    var score = 0;
    CATEGORY_KEYWORDS[cat].forEach(function(kw){ if(lower.indexOf(kw) !== -1) score++; });
    if(score > bestScore){ bestScore = score; best = cat; }
  });
  return best;
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

  execFile('claude', args, { timeout: 55000, maxBuffer: 10 * 1024 * 1024 }, function(err, stdout, stderr){
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

app.listen(PORT, function(){
  console.log('BIG GY INC Daily HQ server running at http://localhost:' + PORT + '/daily_hq.html');
});
