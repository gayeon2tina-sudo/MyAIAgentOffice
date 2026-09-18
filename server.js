const express = require('express');
const { execFile } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8787;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

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
