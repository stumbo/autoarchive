// Opera Wang, 2013/5/1
// GPL V3 / MPL
"use strict";
var EXPORTED_SYMBOLS = ["autoArchiveService"];
const { classes: Cc, Constructor: CC, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/mailServices.js");
Cu.import("resource:///modules/MailUtils.js");
Cu.import("resource:///modules/iteratorUtils.jsm"); // import toXPCOMArray
Cu.import("resource://app/modules/activity/autosync.js");
//Cu.import("resource://app/modules/gloda/utils.js");
//Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("chrome://awsomeAutoArchive/content/aop.jsm");
Cu.import("chrome://awsomeAutoArchive/content/autoArchivePref.jsm");
Cu.import("chrome://awsomeAutoArchive/content/log.jsm");

let autoArchiveService = {
  timer: null,
  statusListeners: [],
  STATUS_INIT: 0, // not used actually
  STATUS_SLEEP: 1,
  STATUS_WAITIDLE: 2,
  STATUS_RUN: 3,
  STATUS_FINISH: 4,
  _status: [],
  start: function(time) {
    let date = new Date(Date.now() + time*1000);
    this.updateStatus(this.STATUS_SLEEP, "Will wakeup @ " + date.toLocaleDateString() + " " + date.toLocaleTimeString());
    if ( !this.timer ) this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.timer.initWithCallback( function() {
      if ( autoArchiveLog && self ) self.waitTillIdle();
    }, time*1000, Ci.nsITimer.TYPE_ONE_SHOT );
  },
  idleService: Cc["@mozilla.org/widget/idleservice;1"].getService(Ci.nsIIdleService),
  idleObserver: {
    delay: null,
    observe: function(_idleService, topic, data) {
      // topic: idle, active
      if ( topic == 'idle' ) self.doArchive();
    }
  },
  waitTillIdle: function() {
    this.updateStatus(this.STATUS_WAITIDLE, "Wait for idle " + autoArchivePref.options.idle_delay + " seconds");
    this.idleObserver.delay = autoArchivePref.options.idle_delay;
    this.idleService.addIdleObserver(this.idleObserver, this.idleObserver.delay); // the notification may delay, as Gecko pool OS every 5 seconds
  },
  cleanupIdleObserver: function() {
    if ( this.idleObserver.delay ) {
      this.idleService.removeIdleObserver(this.idleObserver, this.idleObserver.delay);
      this.idleObserver.delay = null;
    }
  },
  cleanup: function() {
    autoArchiveLog.info("autoArchiveService cleanup");
    this.clear();
    this.statusListeners = [];
    this.timer = null;
    autoArchiveLog.info("autoArchiveService cleanup done");
  },
  clear: function() {
    this.cleanupIdleObserver();
    if ( this.timer ) this.timer.cancel();
    if ( Object.keys(self.wait4Folders).length ) MailServices.mailSession.RemoveFolderListener(self.folderListener);
    this.hookedFunctions.forEach( function(hooked) {
      hooked.unweave();
    } );
    this.hookedFunctions = [];
    this.rules = [];
    this.copyGroups = [];
    this.status = [];
    this.wait4Folders = {};
  },
  rules: [],
  wait4Folders: {},
  stop: function() {
    this.clear();
    this.start(autoArchivePref.options.start_next_delay);
  },
  doArchive: function() {
    autoArchiveLog.info("autoArchiveService doArchive");
    this.clear();
    this.rules = autoArchivePref.rules.filter( function(rule) {
      return rule.enable;
    } );
    this.updateStatus(this.STATUS_RUN, "Total " + this.rules.length + " rule(s)");
    autoArchiveLog.logObject(this.rules, 'this.rules',1);
    this.doMoveOrArchiveOne();
  },
  folderListener: {
    OnItemEvent: function(folder, event) {
      if ( event.toString() != "FolderLoaded" || !folder || !folder.folderURL ) return;
      autoArchiveLog.info("FolderLoaded " + folder.folderURL);
      if ( self.wait4Folders[folder.folderURL] ) delete self.wait4Folders[folder.folderURL];
      if ( Object.keys(self.wait4Folders).length == 0 ) {
        MailServices.mailSession.RemoveFolderListener(self.folderListener);
        self.doMoveOrArchiveOne();
      }
    },
  },
  copyListener: function(group) { // this listener is for Copy/Delete/Move actions
    this.QueryInterface = function(iid) {
      if ( !iid.equals(Ci.nsIMsgCopyServiceListener) && !iid.equals(Ci.nsIMsgFolderListener) && !iid.equals(Ci.nsISupports) )
        throw Components.results.NS_ERROR_NO_INTERFACE;
      return this;
    };
    this.OnStartCopy = function() {
      autoArchiveLog.info("OnStart " + group.action);
      let mail3PaneWindow = Services.wm.getMostRecentWindow("mail:3pane");
      if ( mail3PaneWindow && mail3PaneWindow.gFolderDisplay ) mail3PaneWindow.gFolderDisplay.hintMassMoveStarting();
    };
    this.OnProgress = function(aProgress, aProgressMax) {
      autoArchiveLog.info("OnProgress " + aProgress + "/"+ aProgressMax);
    };
    this.OnStopCopy = function(aStatus) {
      autoArchiveLog.info("OnStop " + group.action);
      if ( group.action == 'delete' || group.action == 'move' ) self.wait4Folders[group.src] = true;
      if ( group.action == 'copy' || group.action == 'move' ) self.wait4Folders[group.dest] = true;
      let mail3PaneWindow = Services.wm.getMostRecentWindow("mail:3pane");
      if ( mail3PaneWindow && mail3PaneWindow.gFolderDisplay ) mail3PaneWindow.gFolderDisplay.hintMassMoveCompleted();
      if ( self.copyGroups.length ) self.doCopyDeleteMoveOne(self.copyGroups.shift());
      else this.updateFolders();
    };
    this.SetMessageKey = function(aKey) {};
    this.GetMessageId = function() {};
    this.msgsDeleted = function(aMsgList) { // Ci.nsIMsgFolderListener, for realDelete message, thus can't get onStopCopy/msgsMoveCopyCompleted
      autoArchiveLog.info("msgsDeleted");
      self.wait4Folders[group.src] = true;
      autoArchiveLog.logObject(aMsgList,'aMsgList',1);
      for (let iMsgHdr = 0; iMsgHdr < aMsgList.length; iMsgHdr++) {
        let msgHdr = aMsgList.queryElementAt(iMsgHdr, Ci.nsIMsgDBHdr);
        let index = group.messages.indexOf(msgHdr);
        if ( index >= 0 ) group.messages.splice(index, 1);
      }
      /*group.messages = group.messages.filter( function(msg) {
        try {
          let index = aMsgList.indexOf(0, msg);
          if ( index >= 0 ) return true;
        } catch(err) {};
        return false;
      } );*/
      if ( group.messages.length == 0 ) {
        autoArchiveLog.info("All msgsDeleted");
        MailServices.mfn.removeListener(this);
        if ( self.copyGroups.length ) self.doCopyDeleteMoveOne(self.copyGroups.shift());
        else this.updateFolders();
      }
    };
    this.updateFolders = function() {
      let folders = [];
      Object.keys(self.wait4Folders).forEach( function(uri) {
        let folder = MailUtils.getFolderForURI(uri, true);
        if ( folder ) folders.push(folder);
        else delete self.wait4Folders[uri];
      } );
      if ( folders.length ) {
        MailServices.mailSession.AddFolderListener(self.folderListener, Ci.nsIFolderListener.event);
        folders.forEach( function(folder) {
          autoArchiveLog.info("updateFolder " + folder.folderURL);
          folder.updateFolder(null);
        } );
      } else self.doMoveOrArchiveOne();
    };
  },
  copyGroups: [], // [ {src: src, dest: dest, action: move, messages[]}, ...]
  hookedFunctions: [],
  searchListener: function(rule) {
    let mail3PaneWindow = Services.wm.getMostRecentWindow("mail:3pane");
    if (!mail3PaneWindow) return self.doMoveOrArchiveOne();
    this.messages = [];
    this.msgHdrsArchive = function() {
      try {
        if ( !this.messages.length ) return self.doMoveOrArchiveOne();
        autoArchiveLog.info("will " + rule.action + " " + this.messages.length + " messages");
        if ( rule.action != 'archive' ) {
          // group messages according to there src and dest
          self.copyGroups = [];
          let groups = {}; // { src-_|_-dest : 0, src2-_|_-dest2: 1 }
          this.messages.forEach( function(msgHdr) {
            let key = msgHdr.folder.folderURL + "-_|_-" + (rule.dest||'');
            if ( typeof(groups.key) == 'undefined'  ) {
              groups.key = self.copyGroups.length;
              self.copyGroups.push({src: msgHdr.folder.folderURL, dest: rule.dest, action: rule.action, messages: []});
            }
            self.copyGroups[groups.key].messages.push(msgHdr);
          } );
          autoArchiveLog.logObject(self.copyGroups, 'copyGroups', 0);
          self.doCopyDeleteMoveOne(self.copyGroups.shift());
        } else {
          let batchMover = new mail3PaneWindow.BatchMessageMover();
          let myFunc = function(result) {
            autoArchiveLog.info("BatchMessageMover OnStopCopy/OnStopRunningUrl");
            autoArchiveLog.logObject(batchMover._batches,'batchMover._batches',1);
            if ( batchMover._batches == null || Object.keys(batchMover._batches).length == 0 ) {
              autoArchiveLog.info("BatchMessageMover Done");
              self.hookedFunctions.forEach( function(hooked) {
                hooked.unweave();
              } );
              self.hookedFunctions = [];
              // TODO: updateFolder
              self.doMoveOrArchiveOne();
            }
            return result;
          }
          self.hookedFunctions.push( autoArchiveaop.after( {target: batchMover, method: 'OnStopCopy'}, myFunc )[0] );
          self.hookedFunctions.push( autoArchiveaop.after( {target: batchMover, method: 'OnStopRunningUrl'}, myFunc )[0] );
          batchMover.archiveMessages(this.messages);
        }
      } catch(err) {
        autoArchiveLog.logException(err);
        return self.doMoveOrArchiveOne();
      }
    };
    this.onSearchHit = function(msgHdr, folder) {
      //autoArchiveLog.info("search hit message:" + msgHdr.mime2DecodedSubject);
      if ( !msgHdr.folder || msgHdr.folder.folderURL == rule.dest ) return;
      if ( ( !autoArchivePref.options.enable_flag && msgHdr.isFlagged ) || ( !autoArchivePref.options.enable_tag && msgHdr.getStringProperty('keywords').contains('$label') ) ) return;
      //let str = ''; let e = msgHdr.propertyEnumerator; let str = "property:\n"; while ( e.hasMore() ) { let k = e.getNext(); str += k + ":" + msgHdr.getStringProperty(k) + "\n"; }; autoArchiveLog.info(str);
      if ( rule.action == 'archive' && ( msgHdr.folder.getFlag(Ci.nsMsgFolderFlags.Archive) || !mail3PaneWindow.getIdentityForHeader(msgHdr).archiveEnabled ) ) {
        autoArchiveLog.info('return:' + msgHdr.subject + "   :" + msgHdr.folder.customIdentity);
        autoArchiveLog.logObject(msgHdr.folder,'msgHdr.folder',0);
        return;
      }
      if ( ['delete', 'move'].indexOf(rule.action) >= 0 && !msgHdr.folder.canDeleteMessages ) return;
      if ( rule.action == 'delete' && ( msgHdr.flags & (Ci.nsMsgMessageFlags.Expunged|Ci.nsMsgMessageFlags.IMAPDeleted) ) ) return;
      //autoArchiveLog.info("add message:" + msgHdr.mime2DecodedSubject);
      this.messages.push(msgHdr);
    };
    this.onSearchDone = function(status) {
      this.msgHdrsArchive();
    };
    this.onNewSearch = function() {};
  },
  doCopyDeleteMoveOne: function(group) {
    let xpcomHdrArray = toXPCOMArray(group.messages, Ci.nsIMutableArray);
    let srcFolder = MailUtils.getFolderForURI(group.src, true);
    let mail3PaneWindow = Services.wm.getMostRecentWindow("mail:3pane");
    let msgWindow;
    if ( mail3PaneWindow ) msgWindow = mail3PaneWindow.msgWindow;
    if ( group.action == 'delete' ) {
      // deleteMessages impacted by srcFolder.server.getIntValue('delete_model')
      // 0:mark as deleted, 1:move to trash, 2:remove it immediately
      let deleteModel = srcFolder.server.getIntValue('delete_model');
      let isTrashFolder = srcFolder.getFlag(Ci.nsMsgFolderFlags.Trash);
      autoArchiveLog.info('srcFolder:' + srcFolder.URI + " is trash? " + isTrashFolder);
      // http://code.google.com/p/reply-manager/source/browse/mailnews/base/test/unit/test_nsIMsgFolderListenerLocal.js
      // if (!isMove && (deleteStorage || isTrashFolder)) => msgsDeleted
      // else => msgsMoveCopyCompleted, onStopCopy
      let realDelete = deleteModel == 2 || isTrashFolder;
      if ( realDelete ) MailServices.mfn.addListener(new self.copyListener(group), MailServices.mfn.msgsDeleted );
      srcFolder.deleteMessages(xpcomHdrArray, null, /*deleteStorage*/realDelete, /*isMove*/false, realDelete ? null : new self.copyListener(group), /* allow undo */false);
      //srcFolder.updateFolder(msgWindow);
      srcFolder.msgDatabase = null; /* don't leak */
      return;
    }
    let isMove = (group.action == 'move') && srcFolder.canDeleteMessages;
    let mail3PaneWindow = Services.wm.getMostRecentWindow("mail:3pane");
    MailServices.copy.CopyMessages(srcFolder, xpcomHdrArray, MailUtils.getFolderForURI(group.dest, true), isMove, new self.copyListener(group), /*msgWindow*/msgWindow, /* allow undo */false);
  },
  doMoveOrArchiveOne: function() {
    //[{"src": "xx", "dest": "yy", "action": "move", "age": 180, "sub": 1, "subject": /test/i, "enable": true}]
    if ( this.rules.length == 0 ) {
      autoArchiveLog.info("auto archive done for all rules, set next");
      this.updateStatus(this.STATUS_FINISH, '');
      return this.start(autoArchivePref.options.start_next_delay);
    }
    let rule = this.rules.shift();
    //autoArchiveLog.logObject(rule, 'running rule', 1);
    this.updateStatus(this.STATUS_RUN, "Running rule " + rule.action + " " + rule.src + ( ["move", "copy"].indexOf(rule.action)>=0 ? " to " + rule.dest : "" ) +
      " with filter { " + "age: " + rule.age + " subject: " + rule.subject + " }");
    let srcFolder = null, destFolder = null;
    try {
      srcFolder = MailUtils.getFolderForURI(rule.src, true);
      if ( ["move", "copy"].indexOf(rule.action) >= 0 ) destFolder = MailUtils.getFolderForURI(rule.dest, true);
    } catch (err) {
      autoArchiveLog.logException(err);
    }
    if ( !srcFolder || ( ["move", "copy"].indexOf(rule.action) >= 0 && !destFolder ) ) {
      autoArchiveLog.log("Error: Wrong rule becase folder does not exist: " + rule.src + ( ["move", "copy"].indexOf(rule.action) >= 0 ? ' or ' + rule.dest : '' ), 1);
      return this.doMoveOrArchiveOne();
    }
    let searchSession = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(Ci.nsIMsgSearchSession);
    searchSession.addScopeTerm(Ci.nsMsgSearchScope.offlineMail, srcFolder);
    if ( rule.sub ) {
      for (let folder in fixIterator(srcFolder.descendants /* >=TB21 */, Ci.nsIMsgFolder)) {
        searchSession.addScopeTerm(Ci.nsMsgSearchScope.offlineMail, folder);
      }
    }
    self.addSearchTerm(searchSession, Ci.nsMsgSearchAttrib.AgeInDays, rule.age || 0, Ci.nsMsgSearchOp.IsGreaterThan);
    if ( typeof(rule.subject) != 'undefined' ) {
      // if subject in format ^/.*/[ismxpgc]*$ and have customTerm expressionsearch#subjectRegex or filtaquilla@mesquilla.com#subjectRegex
      let customId;
      if ( rule.subject.match(/^\/.*\/[ismxpgc]*$/) ) {
        // expressionsearch has logic to deal with Ci.nsMsgMessageFlags.HasRe, use it first
        ['expressionsearch#subjectRegex', 'filtaquilla@mesquilla.com#subjectRegex'].some( function(term) { // .find need TB >=25
          if ( MailServices.filters.getCustomTerm(term) ) {
            customId = term;
            return true;
          } else return false;
        } );
        if ( !customId ) autoArchiveLog.log("Can't support regular expression search patterns '" + rule.subject + "' unless you installed addons like 'Expression Search / GMailUI' or 'FiltaQuilla'", 1);
      }
      if ( customId ) self.addSearchTerm(searchSession, {type: Ci.nsMsgSearchAttrib.Custom, customId: customId}, rule.subject, Ci.nsMsgSearchOp.Matches);
      else self.addSearchTerm(searchSession, Ci.nsMsgSearchAttrib.Subject, rule.subject, Ci.nsMsgSearchOp.Contains);
    }
    searchSession.registerListener(new self.searchListener(rule));
    searchSession.search(null);
  },

  addSearchTerm: function(searchSession, attr, str, op) { // simple version of the one in expression search
    let aCustomId;
    if ( typeof(attr) == 'object' && attr.type == Ci.nsMsgSearchAttrib.Custom ) {
      aCustomId = attr.customId;
      attr = Ci.nsMsgSearchAttrib.Custom;
    }
    let term = searchSession.createTerm();
    term.attrib = attr;
    let value = term.value;
    // This is tricky - value.attrib must be set before actual values, from searchTestUtils.js 
    value.attrib = attr;
    if (attr == Ci.nsMsgSearchAttrib.JunkPercent)
      value.junkPercent = str;
    else if (attr == Ci.nsMsgSearchAttrib.Priority)
      value.priority = str;
    else if (attr == Ci.nsMsgSearchAttrib.Date)
      value.date = str;
    else if (attr == Ci.nsMsgSearchAttrib.MsgStatus || attr == Ci.nsMsgSearchAttrib.FolderFlag || attr == Ci.nsMsgSearchAttrib.Uint32HdrProperty)
      value.status = str;
    else if (attr == Ci.nsMsgSearchAttrib.Size)
      value.size = str;
    else if (attr == Ci.nsMsgSearchAttrib.AgeInDays)
      value.age = str;
    else if (attr == Ci.nsMsgSearchAttrib.Label)
      value.label = str;
    else if (attr == Ci.nsMsgSearchAttrib.JunkStatus)
      value.junkStatus = str;
    else if (attr == Ci.nsMsgSearchAttrib.HasAttachmentStatus)
      value.status = nsMsgMessageFlags.Attachment;
    else
      value.str = str;
    if (attr == Ci.nsMsgSearchAttrib.Custom)
      term.customId = aCustomId;
    term.value = value;
    term.op = op;
    term.booleanAnd = true;
    searchSession.appendTerm(term);
  },

  addStatusListener: function(listener) {
    this.statusListeners.push(listener);
    listener.apply(null, self._status);
  },
  removeStatusListener: function(listener) {
    let index = this.statusListeners.indexOf(listener);
    if ( index ) this.statusListeners.splice(index, 1);
  },
  updateStatus: function(status, detail) {
    if ( detail ) autoArchiveLog.info(detail);
    self._status = [status, detail];
    this.statusListeners.forEach( function(listener) {
      listener.apply(null, self._status);
    } );
  },

};
let self = autoArchiveService;
self.start(autoArchivePref.options.startup_delay);
