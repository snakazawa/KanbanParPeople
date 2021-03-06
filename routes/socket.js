var socketio = require('socket.io');
var _ = require('underscore');
var sessionMiddleware = require('../lib/module/sessionMiddleware');
var Project = require('../lib/model/project');
var User = require('../lib/model/user');
var stages = require('../lib/model/stages');
var LoggerSocket = require('../lib/model/loggerSocket');
var GitHub = require('../lib/model/github');
var queue = require('../lib/module/asyncQueue');
var ChatLog = require('../lib/model/chatLog');


var io;
var emitters;
var firstSendChatLimit = 200;

module.exports = {
    socket: socketRouting,
    emitters: null,
    io: null
};

function socketRouting(server) {
    io = socketio.listen(server);
    var loggerIO = new LoggerSocket.IO(io);
    module.exports.io = loggerIO.io;

    var users = {};

    io.use(function (socket, next) {
        sessionMiddleware(socket.request, {}, next);
    });

    // 接続時
    io.sockets.on('connection', function (socket) {
        console.log('new connected: ' + socket.id);

        var user = {
            info: !socket.request.session ? null :
                !socket.request.session.passport ? null :
                    socket.request.session.passport.user,
            active: true
        };

        users[socket.id] = user;

        // ログインしていなかったら接続を切る
        if (!checkAuth(socket, function (message) { socket.disconnect(message); })) {
            console.error((new Error('must be login: ' + socket.id)).trace);
            return;
        }

        var username = user.info.username;
        var token = user.info.token;

        var loggerSocket = new LoggerSocket.Socket(socket, user);

        /***** イベント登録 *****/

        // プロジェクトルームに参加
        socket.on('join-project-room', function (req, fn) {
            req = req || {};
            fn = fn || function () {};
            var projectId = req.projectId;

            Project.findOne({id: projectId}, function (err, project) {
                if (err) { return serverErrorWrap(err, {}, fn); }
                if (!project) { return userErrorWrap('invalid projectId: ' + projectId, {}, fn); }

                // valid
                leaveProjectRoom(socket);
                joinProjectRoom(socket, projectId);
                loggerSocket.bindProjectId(projectId);

                // 同期用にtokenを保存する
                project.github.token = token;
                project.save(function (err) { if (err) { console.error(err && (err.stack || err)); }});

                // チャットの履歴を送信する
                ChatLog.find({projectId: projectId}, {}, {sort:{ created_at: -1 }, limit: firstSendChatLimit}).exec(function (err, res) {
                    if (err) {
                        console.error(err && (err.stack || err));
                        socket.emit('chat', {
                            sender: 'System', content: 'error: the server could not find chat history.',
                            type: 'error', created_at: Date.now()
                        });
                    } else {
                        res.reverse();
                        socket.emit('chat-history', res);
                    }

                    emitters.joinRoom(projectId, username);
                });

                successWrap('joined room', {}, fn);

                // 同じ部屋にいるユーザ名リストを通知
                // ユニーク処理はしない
                var joinedUserNames = _.chain(users)
                    .values()
                    .where({projectRoomId: projectId, active: true})
                    .map(function (user) { return user.info ? user.info.username : null; })
                    .compact()
                    .value();

                // 自分はいったん除く（後でjoin通知を送る）
                var pos = joinedUserNames.indexOf(username);
                if (pos !== -1) { joinedUserNames.splice(pos, 1); }
                
                socket.emit('init-joined-users', {joinedUserNames: joinedUserNames});
            });
        });

        // memberの追放
        socketOn(socket, 'remove-member', function (req, projectId, fn) {
            emitters.removeMember(projectId, username, token, req.userName, fn);
        });

        // memberの追加
        socketOn(socket, 'add-member', function (req, projectId, fn) {
            emitters.addMember(projectId, username, token, req.userName, fn);
        });

        // memberの更新
        socketOn(socket, 'update-member', function (req, projectId, fn) {
            emitters.updateMember(projectId, username, token, req.userName,
                _.pick(req, ['wipLimit', 'visible']),
                fn);
        });

        socketOn(socket, 'update-member-order', function (req, projectId, fn) {
            emitters.updateMemberOrder(projectId, username, token, req.userName, req.insertBeforeOfUserName, fn);
        });

        // issueの追加
        socketOn(socket, 'add-issue', function (req, projectId, fn) {
            emitters.addIssue(projectId, username, token, {title: req.title, body: req.body, stage: req.stage,
                cost: req.cost, labels: req.labels}, fn);
        });

        // issueの削除
        socketOn(socket, 'remove-issue', function (req, projectId, fn) {
            emitters.removeIssue(projectId, username, token, req.issueId, fn);
        });

        // update stage
        socketOn(socket, 'update-stage', function (req, projectId, fn) {
            emitters.updateStage(projectId, username, token, req.issueId, req.toStage, req.userId, fn);
        });

        // update issue
        socketOn(socket, 'update-issue-detail', function (req, projectId, fn) {
            emitters.updateIssueDetail(projectId, username, token, req.issueId, req.title, req.body, req.cost, fn);
        });

        // update issue working state
        socketOn(socket, 'update-issue-working-state', function (req, projectId, fn) {
            emitters.updateIssueWorkingState(projectId, username, token, req.issueId, req.isWorking, fn);
        });

        // update issue work history
        socketOn(socket, 'update-issue-work-history', function (req, projectId, fn) {
            emitters.updateIssueWorkHistory(projectId, username, token, req.issueId, req.workHistory, fn);
        });

        // update issue priority
        socketOn(socket, 'update-issue-priority', function (req, projectId, fn) {
            emitters.updateIssuePriority(projectId, username, token, req.issueId, req.insertBeforeOfIssueId, fn);
        });

        // attach label
        //attachLabel: function (projectId, token, issueId, labelName, fn) {
        socketOn(socket, 'attach-label', function (req, projectId, fn) {
            emitters.attachLabel(projectId, username, token, req.issueId, req.labelName, fn);
        });

        // detach label
        socketOn(socket, 'detach-label', function (req, projectId, fn) {
            emitters.detachLabel(projectId, username, token, req.issueId, req.labelName, fn);
        });

        // 切断
        socket.on('disconnect', function () {
            var projectId = users[socket.id].projectRoomId;
            if (projectId) {
                emitters.leaveRoom(projectId, username);
            }
            console.log('disconnected: ' + socket.id);
            users[socket.id].active = false;
            delete users[socket.id];
        });
    });

    /**** room *****/

    function joinProjectRoom(socket, projectRoomId) {
        socket.join(projectRoomId);
        users[socket.id].projectRoomId = projectRoomId;
    }

    function leaveProjectRoom(socket) {
        var user = users[socket.id];
        if (!user) { return; }
        var projectRoomId = user.projectRoomId;

        if (projectRoomId) {
            socket.leave(projectRoomId);
        }
    }

    /**** helper *****/

    function socketOn(socket, eventName, callback) {
        socket.on(eventName, function (req, fn) {
            req = req || {};
            fn = fn || function () {};

            if (!checkAuth(socket, fn) || !checkUserInRoom(socket, fn)) { return; }

            var projectId = users[socket.id].projectRoomId;

            callback(req, projectId, fn);
        });
    }

    // passport をチェック
    function checkAuth(socket, fn) {
        var user = users[socket.id];

        if (!user) {
            serverErrorWrap(new Error('undefined user'), {}, fn);
            return false;
        }

        if (!user.info) {
            userErrorWrap('must be login', {}, fn);
            return false;
        }

        return true;
    }

    // roomに入っているか
    function checkUserInRoom(socket, fn) {
        var user = users[socket.id];

        if (!user) {
            serverErrorWrap(new Error('undefined user'), {}, fn);
            return false;
        }

        if (!user.projectRoomId) {
            userErrorWrap('must be join project room', {}, fn);
            return false;
        }

        return true;
    }
}

module.exports.emitters = emitters = {
    joinRoom: function (projectId, username, token) {
        module.exports.io.to(projectId).emit('join-room', {username: username});
        notifyText(projectId, username, 'joined room');
    },

    leaveRoom: function (projectId, username, token) {
        module.exports.io.to(projectId).emit('leave-room', {username: username});
        notifyText(projectId, username, 'left room');
    },

    removeMember: function (projectId, username, token, targetUserName, fn) {
        Project.removeMember({id: projectId}, targetUserName, function (err, project, member) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            successWrap('removed member', {}, fn);
            module.exports.io.to(projectId).emit('remove-member', {member: member});
            notifyText(projectId, username, 'removed member: "' + targetUserName + '"');
        });
    },

    addMember: function (projectId, username, token, targetUserName, fn) {
        Project.addMember({id: projectId}, targetUserName, function (err, project, member) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            (new GitHub(token)).fetchUserAvatar([targetUserName], function (err, path) {
                if (err) { serverErrorWrap(err, {}, fn); return; }

                successWrap('added member', {member: member}, fn);
                module.exports.io.to(projectId).emit('add-member', {member: member});
                notifyText(projectId, username, 'added member: "' + targetUserName + '"');
            });
        });
    },

    updateMember: function (projectId, username, token, targetUserName, updateParams, fn) {
        Project.updateMember({id: projectId}, targetUserName, updateParams, function (err, project, member) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            successWrap('updated member', {member: member}, fn);
            module.exports.io.to(projectId).emit('update-member', {member: member});
            notifyText(projectId, username, 'updated member: "' + targetUserName + '" , ' + JSON.stringify(updateParams));
        });
    },

    updateMemberOrder: function (projectId, username, token, userName, insertBeforeOfUserName, fn) {
        Project.updateMemberOrder({id: projectId}, userName, insertBeforeOfUserName, function (err, project, member, insertBeforeOfMember) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            successWrap('updated member order', {issue: member, insertBeforeOfMember: insertBeforeOfMember}, fn);
            module.exports.io.to(projectId).emit('update-member-order', {member: member, userName: userName,
                insertBeforeOfMember: insertBeforeOfMember, insertBeforeOfUserName: insertBeforeOfUserName, project: project});
            notifyText(projectId, username, 'updated member order: ' + 'insert "' + userName + '" before "' + insertBeforeOfUserName + '"');
        });
    },

    addIssue: function (projectId, username, token, params, fn) {
        queue.push(projectId, function (done) {
            Project.findOne({id: projectId}, function (err, project) {
                if (err) { done(); return serverErrorWrap(err, {}, fn); }
                
                // exists?
                if (params.github && params.github.number && GitHub.findIssueByNumber(project, params.github.number)) {
                    done();
                    console.log('issue already exists: ' + params.github.number);
                    return successWrap('issue already exists.', {}, fn);
                }

                project.addIssue(token, params, function (err, project, issue) {
                    done();

                    if (err) { serverErrorWrap(err, {}, fn); return; }

                    successWrap('added issue', {issue: issue}, fn);
                    if (issue) {
                        module.exports.io.to(projectId).emit('add-issue', {issue: issue});
                        notifyText(projectId, username, 'added issue: ' + params.title);
                    } else {
                        notifyText(projectId, username, 'added issue via GitHub: ' + params.title);
                    }
                });
            });
        });
    },

    removeIssue: function (projectId, username, token, issueId, fn) {
        Project.removeIssue({id: projectId}, token, issueId, function (err, project, issue) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            successWrap('removed issue', {issue: issue}, fn);
            if (issue) {
                module.exports.io.to(projectId).emit('remove-issue', {issue: issue});
                notifyText(projectId, username, 'removed issue: ' + issue.title);
            } else {
                issue = project.findIssueById(issueId);
                notifyText(projectId, username, 'removed issue via GitHub: ' + (issue ? issue.title : issueId));
            }
        });
    },

    // ステージとアサインを同時に処理する
    updateStage: function (projectId, username, token, issueId, toStage, userId, fn) {
        Project.updateStage({id: projectId}, token, issueId, toStage, userId, function (err, project, issue) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            successWrap('updated stage', {issue: issue}, fn);
            module.exports.io.to(projectId).emit('update-stage', {issue: issue, issueId: issueId, toStage: toStage, assignee: userId});
            User.findById(userId, function (err, res) {
                notifyText(projectId, username, 'updated issue stage and assignee: ' +
                    JSON.stringify({title: issue.title, stage: toStage, assignee: (err || !res) ? userId : res.userName}));
            });
        });
    },

    updateIssueDetail: function (projectId, username, token, issueId, title, body, cost, fn) {
        Project.updateIssueDetail({id: projectId}, token, issueId, title, body, cost, function (err, project, issue) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            successWrap('updated issue detail', {issue: issue}, fn);
            module.exports.io.to(projectId).emit('update-issue-detail', {issue: issue, issueId: issueId});
            notifyText(projectId, username, 'updated issue detail: ' + JSON.stringify({title: title, body: body, cost: cost}));
        });
    },

    updateIssueWorkingState: function (projectId, username, token, issueId, isWorking, fn) {
        queue.push(projectId, function (done) {
            Project.updateIssueWorkingState({id: projectId}, issueId, isWorking, function (err, project, issue) {
                done();
                if (err) { serverErrorWrap(err, {}, fn); return; }

                successWrap('update issue working status', {issue: issue, isWorking: isWorking}, fn);
                module.exports.io.to(projectId).emit('update-issue-working-state', { issue: issue, issueId: issueId, isWorking: isWorking });
                notifyText(projectId, username, (isWorking ? 'start to work: ' : 'stop to work: ') + issue.title);
            });
        });
    },

    updateIssueWorkHistory: function (projectId, username, token, issueId, workHistory, fn) {
        queue.push(projectId, function (done) {
            Project.updateIssueWorkHistory({id: projectId}, issueId, workHistory, function (err, project, issue) {
                done();
                if (err) { serverErrorWrap(err, {}, fn); return; }

                successWrap('update issue work history', {issue: issue, workHistory: issue.workHistory}, fn);
                module.exports.io.to(projectId).emit('update-issue-work-history', {issue: issue, workHistory: issue.workHistory});
                notifyText(projectId, username, 'updated work history: ' + issue.title);
            });
        });
    },

    updateIssuePriority: function (projectId, username, token, issueId, insertBeforeOfIssueId, fn) {
        Project.updateIssuePriority({id: projectId}, issueId, insertBeforeOfIssueId, function (err, project, issue, insertBeforeOfIssueId) {
            if (err) { serverErrorWrap(err, {}, fn); return; }

            successWrap('updated issue priority', {issue: issue, insertBeforeOfIssueId: insertBeforeOfIssueId}, fn);
            module.exports.io.to(projectId).emit('update-issue-priority', {issue: issue, issueId: issueId, insertBeforeOfIssueId: insertBeforeOfIssueId});

            var insertBeforeOfIssue = project.findIssueById(insertBeforeOfIssueId);
            notifyText(projectId, username, 'updated issue priority: ' +
                    'inserted "' + issue.title + '" before "' + (insertBeforeOfIssue ? insertBeforeOfIssue.title : insertBeforeOfIssueId) + '"');
        });
    },

    attachLabel: function (projectId, username, token, issueId, labelName, fn) {
        queue.push(projectId, function (done) {
            Project.attachLabel({id: projectId}, token, issueId, labelName, function (err, project, issue, label) {
                done();
                if (err) { serverErrorWrap(err, {}, fn); return; }

                successWrap('attached label', {issue: issue, label: label}, fn);
                if (issue && label) {
                    module.exports.io.to(projectId).emit('attach-label', { issue: issue, issueId: issueId, label: label });
                    notifyText(projectId, username, 'attached label: ' + JSON.stringify({title: issue.title, label: labelName}));
                } else {
                    issue = project.findIssueById(issueId);
                    notifyText(projectId, username, 'attached label via GitHub: ' +
                        JSON.stringify({title: (issue ? issue.title : issueId), label: labelName}));
                }
            });
        });
    },

    detachLabel: function (projectId, username, token, issueId, labelName, fn) {
        queue.push(projectId, function (done) {
            Project.detachLabel({id: projectId}, token, issueId, labelName, function (err, project, issue, label) {
                done();
                if (err) { serverErrorWrap(err, {}, fn); return; }

                successWrap('detached label', {issue: issue, label: label}, fn);
                if (issue && label) {
                    module.exports.io.to(projectId).emit('detach-label', { issue: issue, issueId: issueId, label: label });
                    notifyText(projectId, username, 'detached label: ' + JSON.stringify({title: issue.title, label: labelName}));
                } else {
                    issue = project.findIssueById(issueId);
                    notifyText(projectId, username, 'detached label via GitHub: ' +
                        JSON.stringify({title: (issue ? issue.title : issue), label: labelName}));
                }
            });
        });
    },

    syncLabelAll: function (projectId, username, token, fn) {
        queue.push(projectId, function (done) {
            Project.findOne({id: projectId}, function (err, project) {
                if (err) { return error(err, fn, done); }

                var github = new GitHub(token);
                github.syncLabelsFromGitHub(project.github.repoName, project.github.userName, project, function (err, project) {
                    if (err) { return error(err, fn, done); }

                    github.syncIssuesFromGitHub(project.github.repoName, project.github.userName, project, ['labels'], function (err, project) {
                        if (err) { return error(err, fn, done); }

                        successWrap('done to sync label all', {project: project}, fn);
                        module.exports.io.to(projectId).emit('sync-label-all', {project: project});
                        notifyText(projectId, username, 'synchronized all labels. *** Please update this page. ***');
                    });
                });
            });
        });

        function error(err, fn, done) {
            serverErrorWrap(err, {}, fn);
            done();
        }
    }
};

/*** helper ***/

function serverErrorWrap(err, otherParam, fn) {
    console.error('server error: ', err && (err.stack || err));
    fn(_.extend({
        status: 'server error',
        message: err.message
    }, otherParam || {}));
}

function userErrorWrap(message, otherParam, fn) {
    console.error('user error: ' + message);
    fn(_.extend({
        status: 'error',
        message: message
    }, otherParam || {}));
}

function successWrap(message, otherParam, fn) {
    fn(_.extend({
        status: 'success',
        message: message
    }, otherParam || {}));
}

function notifyText(projectId, username, text) {
    var content = '"' + username + '" ' + text;
    ChatLog.create({sender: 'System', content: content, type: 'system', projectId: projectId}, function (err, log) {
        if (err) {
            console.error(err && (err.stack || err));
            module.exports.io.to(projectId).emit('chat', {
                sender: 'System', content: 'error: the server could not create system log.',
                type: 'error', created_at: Date.now()
            });
        } else {
            module.exports.io.to(projectId).emit('chat', log);
        }
    });
}