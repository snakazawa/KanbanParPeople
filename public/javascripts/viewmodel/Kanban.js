(function (ko, util) {
    'use strict';

    var ns = util.namespace('kpp.viewmodel'),
        model = util.namespace('kpp.model'),
        User = model.User,
        Issue = model.Issue;

    ns.Kanban = ns.Kanban || Kanban;

    function Kanban(o) {
        var that = this;
        var alert = o.alert;

        that.members = ko.observableArray();

        that.issues = ko.observableArray();

        that.init = function (project) {
            that.members = project.members;
            that.issues = project.issues;
        };
    }

}(ko, window.nakazawa.util));