module.exports = GitHubHook;

function GitHubHook(token) {
    var GitHub = require('../github'); // 先頭で読み込むと依存関係でエラー...
    this.api = new GitHub(token);
}

GitHubHook.isHooked = function (project) {
    return project.github && project.github.sync;
};

GitHubHook.prototype.addIssue = function (project, params, callback) {
    this.api.createIssue(project.github.repoName, project.github.userName, params, callback);
};

GitHubHook.prototype.removeIssue = function (project, params, callback) {
    this.api.closeIssue(project.github.repoName, project.github.userName, params.issue, callback);
};