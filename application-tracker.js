/* Read-only Google Sheet adapter. No private tracker rows are bundled here. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ApplicationTracker=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function normalize(v){return String(v==null?'':v).trim().toLowerCase().replace(/[\u2010-\u2015]/g,'-').replace(/\s+/g,' ');}
  function statusKind(value){
    var s=normalize(value).replace(/^\d+\s*[-:.]\s*/,'');
    if(/\bprospecting\b/.test(s))return 'prospect';
    if(['applied','screening interview','first round interview','second round interview','final round interview','rejected','offer','no reply'].indexOf(s)!==-1)return 'submitted';
    return 'review';
  }
  function day(value){
    var raw=String(value||'').trim(),m=/^Date\((\d+),\s*(\d+),\s*(\d+)/.exec(raw),y,mo,d;
    if(m){y=+m[1];mo=+m[2]+1;d=+m[3];}
    else if((m=/^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw))){y=+m[1];mo=+m[2];d=+m[3];}
    else if((m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw))){y=+m[3];mo=+m[1];d=+m[2];}
    else return null;
    var date=new Date(Date.UTC(y,mo-1,d));
    if(date.getUTCFullYear()!==y||date.getUTCMonth()!==mo-1||date.getUTCDate()!==d)return null;
    return String(y).padStart(4,'0')+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');
  }
  function safeUrl(value){try{var u=new URL(String(value||'').trim());return /^https?:$/.test(u.protocol)?u.href:'';}catch(e){return '';}}
  function canonicalUrl(value){var raw=safeUrl(value);if(!raw)return '';var u=new URL(raw);u.hash='';Array.from(u.searchParams.keys()).forEach(function(k){if(/^utm_|^(trk|trackingId|refId|source|ref)$/i.test(k))u.searchParams.delete(k);});u.searchParams.sort();return u.href.replace(/\/$/,'');}
  function parse(table,today){
    if(!table||!Array.isArray(table.cols)||!Array.isArray(table.rows))throw new Error('The tracker did not return a readable table.');
    var cols=table.cols.map(function(c){return normalize(c.label);});
    function col(name,required){var i=cols.indexOf(name);if(required&&i<0)throw new Error('Tracker column missing: '+name+'.');return i;}
    var ix={role:col('role',true),company:col('company',true),status:col('round status',true),date:col('date applied'),url:col('application link'),location:col('location'),notes:col('notes'),id:col('role id')};
    var items=[],seen={};
    table.rows.forEach(function(row,index){
      function value(k){var c=row.c&&row.c[ix[k]];return c&&c.v!=null?String(c.v).trim():'';}
      var role=value('role'),company=value('company');if(!role&&!company)return;
      var url=safeUrl(value('url')),fallback=normalize(company)+'|'+normalize(role),stable=value('id');
      var key=stable?'id:'+stable:url?'url:'+canonicalUrl(url):'name:'+fallback;
      var status=value('status'),kind=statusKind(status),appliedDate=day(value('date')),issues=[];
      if(!role||!company){kind='review';issues.push('Add both role and company.');}
      if(kind==='review')issues.push('Confirm what this status means before counting a submission.');
      if(kind==='submitted'&&!appliedDate)issues.push('Date Applied is missing or invalid; no fish awarded.');
      if(appliedDate&&appliedDate>today){issues.push('Date Applied is in the future; no fish awarded.');appliedDate=null;}
      if(kind==='submitted'&&/\bnot (?:yet )?applied\b/i.test(value('notes')))issues.push('Notes still say not applied; check whether the notes are outdated.');
      if(!url)issues.push('Application link is missing or invalid.');
      if(seen[key]){seen[key].issues.push('Duplicate role identity in tracker; counted once.');return;}
      var item={key:key,fallback:fallback,row:index+2,role:role,company:company,status:status,kind:kind,appliedDate:appliedDate,url:url,location:value('location'),issues:issues};
      seen[key]=item;items.push(item);
    });return items;
  }
  function label(item,done){return (done?'Applied to ':'Apply to ')+item.company+' — '+item.role;}
  return {normalize:normalize,statusKind:statusKind,day:day,safeUrl:safeUrl,canonicalUrl:canonicalUrl,parse:parse,label:label};
});
