var express = require('express');
var router = express.Router();
var socket = require('./socket');
var async = require('async');
var Project = require('../lib/model/project');
var User = require('../lib/model/user');
var GitHub = require('../lib/model/github');
var stages = require('../lib/model/stages');
var _ = require('underscore');

// GitHub Webhooks のルーティング

var routes = {
    issues: {
        opened: function (project, req, res) {
            GitHub.serializeIssue(project, req.body.issue, function (err, issue) {
                if (err) {
                    console.error(err && (err.stack || err));
                    return res.status(500).json({message: err.message});
                }

                socket.emitters.addIssue(project.id, 'GitHub', null, issue, _.noop);
                res.status(200).json({});
            });
        },
        closed: function (project, req, res) {
            var issue = GitHub.findIssueByNumber(project, req.body.issue.number);
            if (!issue) {
                return routes.issues.opened(project, req, res);
            }

            // 変更の必要がなければ何もしない
            if (issue.stage === stages.archive || issue.stage === stages.done) {
                return res.status(200).json({});
            }
            
            socket.emitters.updateStage(project.id, 'GitHub', null, issue._id, stages.done, null, _.noop);
            res.status(200).json({});
        },
        reopened: function (project, req, res) {
            var issue = GitHub.findIssueByNumber(project, req.body.issue.number);
            if (!issue) {
                return routes.issues.opened(project, req, res);
            }

            // 変更の必要がなければ何もしない
            if (issue.stage !== stages.archive && issue.stage !== stages.done) {
                return res.status(200).json({});
            }

            socket.emitters.updateStage(project.id, 'GitHub', null, issue._id, stages.issue, null, _.noop);
            res.status(200).json({});
        },
        assigned: function (project, req, res) {
            var issue = GitHub.findIssueByNumber(project, req.body.issue.number);
            if (!issue) {
                return routes.issues.opened(project, req, res);
            }

            var toAssignee = req.body.assignee.login;

            if (issue.assignee) {
                User.findById(issue.assignee, function (err, user) {
                    if (err) {
                        console.error(err && (err.stack || err));
                        return res.status(500).json({message: err.message});
                    }
                    if (user.userName === toAssignee) {
                        // 変更の必要がなければ何もしない
                        console.log('already assigned');
                        res.status(200).json({message: 'already assigned'});
                    } else {
                        // assign
                        console.log('replace assign');
                        socket.emitters.updateStage(project.id, 'GitHub', null, issue._id, stages.todo, user._id, _.noop);
                        res.status(200).json({});
                    }
                });
            } else {
                User.findOrCreate(toAssignee, function (err, user) {
                    if (err) {
                        console.error(err && (err.stack || err));
                        res.status(500).json({message: err.message});
                    } else {
                        console.log('assign: ' + JSON.stringify({issue: issue._id, user: user._id}));
                        socket.emitters.updateStage(project.id, 'GitHub', null, issue._id, stages.todo, user._id, _.noop);
                        res.status(200).json({});
                    }
                });
            }
        },
        unassigned: function (project, req, res) {
            var issue = GitHub.findIssueByNumber(project, req.body.issue.number);
            if (!issue) {
                return routes.issues.opened(project, req, res);
            }

            // 変更が必要なければ何もしない
            if (issue.assignee === null) {
                return res.status(200).json({});
            }

            socket.emitters.updateStage(project.id, 'GitHub', null, issue._id, stages.backlog, null, _.noop);
            res.status(200).json({});
        },
        labeled: function (project, req, res) {
            var issue = GitHub.findIssueByNumber(project, req.body.issue.number);
            if (!issue) {
                return routes.issues.opened(project, req, res);
            }

            // 存在しないラベル、あるいはカラーが異なる場合はラベルに関するすべての情報を更新する
            // GitHubと本システムで、名前とカラーは同じだが異なるラベルのような場合は、ここでは想定していない
            var label = project.findLabelByName(req.body.label.name);
            if (!label || String(label.color) !== String(req.body.label.color)) {
                return syncLabelAll(project, req, res);
            }

            // 変更が必要なければ何もしない
            var issueLabels = project.expandIssueLabel(issue);
            var issueLabel = _.find(issueLabels, function (x) { return String(x.name) === String(label.name); });
            if (issueLabel) {
                return res.status(200).json({});
            }

            // ラベルを付ける
            socket.emitters.attachLabel(project.id, 'GitHub', null, issue._id, label.name, _.noop);
            res.status(200).json({});
        },
        unlabeled: function (project, req, res) {
            var issue = GitHub.findIssueByNumber(project, req.body.issue.number);
            if (!issue) {
                return routes.issues.opened(project, req, res);
            }

            // 存在しないラベル、あるいはカラーが異なる場合はラベルに関するすべての情報を更新する
            // GitHubと本システムで、名前とカラーは同じだが異なるラベルのような場合は、ここでは想定していない
            var label = project.findLabelByName(req.body.label.name);
            if (!label || String(label.color) !== String(req.body.label.color)) {
                return syncLabelAll(project, req, res);
            }

            // 変更が必要なければ何もしない
            var issueLabels = project.expandIssueLabel(issue);
            var issueLabel = _.find(issueLabels, function (x) { return String(x.name) === String(label.name); });
            if (!issueLabel) {
                return res.status(200).json({});
            }

            // ラベルを外す
            socket.emitters.detachLabel(project.id, 'GitHub', null, issue._id, label.name, _.noop);
            res.status(200).json({});
        }
    }
};

router.post('/:projectId', function (req, res) {
    var type = req.get('x-Github-Event');
    var action = req.body && req.body.action;

    // projetの特定
    Project.findPopulated({id: req.params.projectId}, {one: true}, function (err, project) {
        if (err) {
            console.error(err && (err.stack || err));
            res.status(500).json({message: err.message});
            return;
        }
        if (!project) {
            console.error((new Error('project not found: ' + req.params.projectId)).trace);
            res.status(400).json({message: 'project not found'});
            return;
        }

        // ルーティング
        if (!~Object.keys(routes).indexOf(type) ||
            !~Object.keys(routes[type]).indexOf(action)) {
            console.error((new Error('routing not matched: ' + type + ' ' + action)).trace);
            res.status(400).end();
        } else {
            routes[type][action](project, req, res);
        }
    });
});

function syncLabelAll(project, httpReq, httpRes) {
    console.log('unmatch project labels and sync all labels');
    socket.emitters.syncLabelAll(project.id, 'GitHub', null, function (res) {
        if (res.status === 'success') {
            httpRes.status(200).json({status: res.status, message: 'unmatch project labels and sync all labels'});
        } else {
            httpRes.status(500).json(res);
        }
    });
}

module.exports = router;
