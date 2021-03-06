var mongoose = require('mongoose');
var monky = new (require('monky'))(mongoose);
var async = require('async');
var Project = require('../../model/project');
module.exports.monky = monky;

require('./user');
require('./issue');
require('./project');
require('./label');

module.exports.setup = function (callback) {
    async.series({
        user: function (next) { monky.create('User', next); },
        issueParams: function (next) { monky.build('Issue', next); },
        issues: function (next) { monky.createList('Issue', 3, next); },
        userParams: function (next) { monky.build('User', next); },
        users: function (next) { monky.createList('User', 2, next); },
        label: function (next) { monky.build('Label', next); },
        labels: function (next) { monky.createList('Label', 3, next); }
    }, function (err, res) {
        if (err) { return callback(err); }

        monky.create('Project', {
            create_user: res.user._id,
            issues: res.issues,
            members: [{user: res.user._id}, {user: res.users[0]._id}, {user: res.users[1]._id}],
            labels: res.labels
        }, function (err, project) {
            if (err) { return callback(err); }
            Project.findPopulated({id: project.id}, {one: true}, function (err, doc) {
                if (err) { return callback(err); }
                res.project = doc;
                callback(null, res);
            });
        });
    });
};