//-----------------------
// NODEJS MODULES
//-----------------------

var phantomjs = require('phantomjs-prebuilt'),
    childProcess = require('child_process'),
    css = require('css'),
    cssCleaner = require('clean-css'),
    fs = require('fs'),
    jsdom = require("jsdom"),
    mediaQueryMatcher = require('css-mediaquery'),
    path = require('path'),
    request = require('request'),
    urlparse = require("url");

var focusrHelper = require("./lib/helpers.js");

//-----------------------
// GLOBAL VARIABLES
//-----------------------

var global = {},
    defaultConfig = {
        "autoOpen": false,
        "debug": false,
        "allowJs": false,
        "processExternalCss": true,
        "inlineNonCritical": false,
        "groups": []
    },
    defaultGroup = {
        "enabled": true,
        "baseDir": "tests/",
        "inputFile": "",
        "outputFile": "",
        "alwaysInclude": [],
        "httpAuth": "",
        "wordpress": false,
        "viewport": [1200, 900],
        "outputJS": false
    };

//-----------------------
// FUNCTIONS
//-----------------------

function parseConfig(json) {
    focusrHelper.intro();

    var groupID = 1;
    global = extendConfig(defaultConfig, json);
    global["runningGroups"] = 0;
    for (var i = 0; i < global["groups"].length; i++) {
        var groupObject = global["groups"][i] = extendConfig(defaultGroup, global["groups"][i]);
        if (!groupObject["enabled"]) {
            continue;
        }
        if (groupObject["wordpress"]) {
            prepWordpress(groupObject, groupID++);
        }
        else {
            groupObject["groupID"] = groupID++;
            global["runningGroups"]++;
            parseGroup(groupObject);
        }
    }
}

function focus(baseDir, inputFile, outputFile) {
    global = extendConfig(defaultConfig, {});
    var newGroup = extendConfig(defaultGroup, {});
    newGroup["baseDir"] = baseDir;
    newGroup["inputFile"] = inputFile;
    newGroup["outputFile"] = outputFile;
    newGroup["groupID"] = 0;
    global["runningGroups"] = 1;
    parseGroup(newGroup);
}

function prepWordpress(groupObject, groupID) {
    var linksUrl = groupObject["inputFile"] + "?focusr=yes";
    if (groupObject["httpAuth"] !== "") {
        linksUrl = focusrHelper.injectAuth(linksUrl, groupObject["httpAuth"]);
    }
    request(linksUrl, function (error, response, data) {
        if (!error && response.statusCode == 200) {
            try {
                var links = JSON.parse(data);
                var subgroupID = 1;
                for (var key in links) {
                    if (links.hasOwnProperty(key)) {
                        var newGroup = extendConfig(defaultGroup, groupObject);
                        newGroup["wordpress"] = false;
                        newGroup["inputFile"] = links[key] + "?focusr=no";
                        newGroup["outputFile"] = key + ".css";
                        newGroup["outputJS"] = key + ".js";
                        newGroup["groupID"] = groupID + "." + subgroupID++;
                        global["runningGroups"]++;
                        parseGroup(newGroup);
                    }
                }
            }
            catch (exception) {
                focusrHelper.logMessage(groupObject["groupID"], "Bad response from WordPress URL " + groupObject["inputFile"] + "?focusr=yes: " + exception.message, 2);
            }
        }
        else {
            focusrHelper.logMessage(groupObject["groupID"], "Error fetching links from WordPress URL " + groupObject["inputFile"] + "?focusr=yes", 2);
        }
    });
}

function extendConfig(baseConfig, userConfig) {
    var newConfig = {};
    for (var key in baseConfig) {
        if (baseConfig.hasOwnProperty(key)) {
            newConfig[key] = baseConfig[key];
        }
    }
    for (key in userConfig) {
        if (userConfig.hasOwnProperty(key)) {
            newConfig[key] = userConfig[key];
        }
    }
    return newConfig;
}

function parseGroup(groupObject) {
    groupObject["remainingCSSFiles"] = 0;
    if (focusrHelper.isRemoteUrl(groupObject["inputFile"])) {
        var url = groupObject["inputFile"];
        if (groupObject["httpAuth"] !== "") {
            url = focusrHelper.injectAuth(url, groupObject["httpAuth"]);
        }

        request(url, function (error, response, htmlData) {
            if (!error && response.statusCode == 200) {
                groupObject["HTML"] = htmlData;
                findCSSFiles(groupObject);
            }
            else {
                focusrHelper.logMessage(groupObject["groupID"], "Error fetching remote file", 2);
            }
        });

    }
    else {
        groupObject["HTML"] = fs.readFileSync(groupObject["baseDir"] + groupObject["inputFile"], "utf-8");
        findCSSFiles(groupObject);
    }
}

function findCSSFiles(groupObject) {
    jsdom.env({
        html: groupObject["HTML"],
        done: function (error, window) {
            if (!error) {
                var stylesheets = window.document.head.querySelectorAll("link[rel='stylesheet']");
                for (var i = 0; i < stylesheets.length; i++) {
                    var cssFile = stylesheets[i].getAttribute("href");
                    if (!focusrHelper.isRemoteUrl(cssFile) || (global["processExternalCss"] && focusrHelper.isRemoteUrl(cssFile))) {
                        groupObject["remainingCSSFiles"]++;
                        readCSS(cssFile, groupObject);
                    }
                }
            }
            else {
                focusrHelper.logMessage(groupObject["groupID"], "A jsdom error occurred: " + error, 2);
            }
        }
    });
}

function readCSS(cssUrl, groupObject) {
    var unmodifiedCssUrl = cssUrl;

    // Protocol-less URL fix
    if (cssUrl.indexOf("//") == 0) {
        cssUrl = "http:" + cssUrl;
    }

    // Relative CSS URL in a remote input file fix
    if (focusrHelper.isRemoteUrl(groupObject["inputFile"]) && !focusrHelper.isRemoteUrl(cssUrl)) {
        cssUrl = urlparse.resolve(groupObject["inputFile"], cssUrl);
    }

    if (focusrHelper.isRemoteUrl(cssUrl)) {
        var url = cssUrl;
        if (groupObject["httpAuth"] !== "") {
            url = focusrHelper.injectAuth(url, groupObject["httpAuth"]);
        }

        request(url, function (error, response, cssData) {
            var responseData = undefined;
            if (!error && response.statusCode == 200) {
                responseData = cssData.toString();
            }
            else {
                focusrHelper.logMessage(groupObject["groupID"], "Error fetching remote file '" + cssUrl + "'", 2);
            }
            createAST(responseData, unmodifiedCssUrl, groupObject);
        });
    }
    else {
        // Base relative URL in local file fix
        if (focusrHelper.isBaseRelative(cssUrl)) {
            cssUrl = groupObject["baseDir"] + cssUrl.substring(1);
        }
        // Relative URL in local file fix
        else {
            cssUrl = groupObject["baseDir"] + path.dirname(groupObject["inputFile"]).substring(1) + cssUrl;
        }

        fs.readFile(cssUrl, 'utf8', function (error, cssData) {
            var responseData = undefined;
            if (!error) {
                responseData = cssData;
            }
            else {
                focusrHelper.logMessage(groupObject["groupID"], "Error fetching remote file '" + cssUrl + "'", 2);
            }
            createAST(responseData, unmodifiedCssUrl, groupObject);
        });
    }

}

function createAST(cssData, unmodifiedCssUrl, groupObject) {
    groupObject["remainingCSSFiles"]--;

    // Successful fetch of data
    if (cssData !== undefined) {
        //First CSS file, build the initial AST tree
        if (groupObject["CSSAST"] === undefined) {
            groupObject["CSSAST"] = css.parse(cssData, {silent: true});
        }
        //Already existing CSS AST, append newly parsed rules to it
        else {
            var CSSAST = css.parse(cssData, {silent: true});
            groupObject["CSSAST"]["stylesheet"]["rules"] = groupObject["CSSAST"]["stylesheet"]["rules"].concat(CSSAST["stylesheet"]["rules"]);
        }
    }

    // All CSS files found in group processed
    if (groupObject["remainingCSSFiles"] == 0) {
        // Transform all relative URLs in CSS into relative to the output file
        var rules = groupObject["CSSAST"]["stylesheet"]["rules"];
        transformRulesRelativeToOutput(rules, unmodifiedCssUrl);
        markAllRulesAsNoncritical(rules);
        markMatchingMediaQueriesAsCritical(rules, groupObject);
        if (groupObject["alwaysInclude"].length > 0) {
            for (var i = 0; i < groupObject["alwaysInclude"].length; i++) {
                markAlwaysIncludesAsCritical(rules, groupObject["alwaysInclude"][i]);
            }
        }
        checkIfSelectorsHit(groupObject, groupObject["CSSAST"]);
    }
}

function markAllRulesAsNoncritical(rules) {
    for (var i = 0; i < rules.length; i++) {
        rules[i]["critical"] = false;
    }
}

function markMatchingMediaQueriesAsCritical(rules, groupObject) {
    for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule["type"] === "media") {
            rule["critical"] = mediaQueryMatchesViewport(rule["media"], groupObject["viewport"][0], groupObject["viewport"][1]);
        }
    }
}

function markAlwaysIncludesAsCritical(rules, ruleToInclude) {
    var regexPattern = new RegExp(ruleToInclude);
    for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule["rules"] !== undefined) {
            markAlwaysIncludesAsCritical(rule["rules"], ruleToInclude);
        }
        else if (rule["selectors"] !== undefined) {
            for (var j = 0; j < rule["selectors"].length; j++) {
                var selector = rule["selectors"][j];
                if (regexPattern.test(selector)) {
                    rule["critical"] = true;
                }
            }
        }
    }
}

function mediaQueryMatchesViewport(mediaQuery, width, height) {
    return mediaQueryMatcher.match(mediaQuery, {
        width: width + 'px',
        height: height + 'px',
        type: 'screen'
    });
}

function checkIfSelectorsHit(groupObject, CSSAST) {

    var tmpCssFile = groupObject["baseDir"] + groupObject["outputFile"] + Date.now() + ".txt";
    var viewportW = groupObject["viewport"][0];
    var viewportH = groupObject["viewport"][1];
    var html = groupObject["HTML"];

    var htmlFile = groupObject["baseDir"] + groupObject["outputFile"];
    if (focusrHelper.isRemoteUrl(groupObject["inputFile"])) {
        htmlFile += ".html";
    }

    focusrHelper.writeFile(htmlFile, html);
    focusrHelper.writeFile(tmpCssFile, JSON.stringify(CSSAST));
    focusrHelper.logMessage(groupObject["groupID"], "Calling PhantomJS");

    var phantomArguments = [path.join(__dirname, 'phantomJS.js'), htmlFile, tmpCssFile, viewportW, viewportH];

    childProcess.execFile(phantomjs.path, phantomArguments, function (error, output, errorOutout) {
        if (!error) {
            var result = output.trim();
            if (result === "true") {
                focusrHelper.logMessage(groupObject["groupID"], "PhantomJS reported back");
                var parseError = false;
                var processedAST;
                try {
                    processedAST = JSON.parse(fs.readFileSync(tmpCssFile, "utf-8"));
                }
                catch (exception) {
                    parseError = true;
                    focusrHelper.logMessage(groupObject["groupID"], "Error occurred while paring PhantomJS output: " + exception.message, 2);
                }

                if (!parseError) {
                    sliceCss(groupObject, processedAST, tmpCssFile);
                }
            }
            else {
                focusrHelper.logMessage(groupObject["groupID"], "A controlled exception occurred: " + json["errorMessage"] + " " + output, 2);
            }

        }
        else {
            focusrHelper.logMessage(groupObject["groupID"], "A PhantomJS error occurred: " + output + " " + errorOutout, 2);
        }
    });
}

function sliceCss(groupObject, processedAST, tmpCssFile) {
    //Deep cloning
    var criticalCssAst = JSON.parse(JSON.stringify(processedAST)), nonCriticalCssAst = JSON.parse(JSON.stringify(processedAST));
    var originalRules = processedAST["stylesheet"]["rules"], criticalRules = criticalCssAst["stylesheet"]["rules"], nonCriticalRules = nonCriticalCssAst["stylesheet"]["rules"];

    for (var i = 0; i < originalRules.length; i++) {
        var rule = originalRules[i];
        if (rule["critical"]) {
            nonCriticalRules[i] = undefined;
        }
        else {
            criticalRules[i] = undefined;
        }
    }

    criticalCssAst["stylesheet"]["rules"] = focusrHelper.balanceArray(criticalRules);
    nonCriticalCssAst["stylesheet"]["rules"] = focusrHelper.balanceArray(nonCriticalRules);

    var criticalCss = css.stringify(criticalCssAst), nonCriticalCss = css.stringify(nonCriticalCssAst);
    var minifiedCriticalCss = new cssCleaner().minify(criticalCss).styles, minifiedNonCriticalCss = new cssCleaner().minify(nonCriticalCss).styles;

    generateResult(minifiedCriticalCss, minifiedNonCriticalCss, groupObject, tmpCssFile);
}

function generateResult(criticalCss, nonCriticalCss, groupObject, tmpCssFile) {
    jsdom.env({
        html: groupObject["HTML"],
        done: function (error, window) {
            if (error) {
                focusrHelper.logMessage(groupObject["groupID"], "A jsdom error occurred: " + error, 2);
                return;
            }

            var head = window.document.head || window.document.getElementsByTagName('head')[0];
            var body = window.document.body || window.document.getElementsByTagName('body')[0];
            var stylesheets = head.querySelectorAll("link[rel='stylesheet']");

            if (focusrHelper.isRemoteUrl(groupObject["inputFile"])) {
                groupObject["criticalCss"] += criticalCss;
                if (groupObject["outputJS"]) {
                    focusrHelper.writeFile(groupObject["baseDir"] + groupObject["outputJS"], focusrHelper.generateLoadCSSJS(stylesheets));
                    focusrHelper.logMessage(groupObject["groupID"], "File '" + groupObject["baseDir"] + groupObject["outputJS"] + "' generated", 1);
                }
            }
            else {
                head.appendChild(focusrHelper.generateStyleTag(window, criticalCss));
                for (var i = 0; i < stylesheets.length; i++) {
                    head.removeChild(stylesheets[i]);
                }

                if (global["inlineNonCritical"]) {
                    body.appendChild(focusrHelper.generateStyleTag(window, nonCriticalCss));
                }
                else {
                    var jsForLoadCss = window.document.createElement('script');
                    jsForLoadCss.innerHTML = focusrHelper.generateLoadCSSJS(stylesheets);
                    body.appendChild(jsForLoadCss);
                }
            }

            focusrHelper.collectGarbage(tmpCssFile, groupObject);
            global["runningGroups"]--;

            if (focusrHelper.isRemoteUrl(groupObject["inputFile"])) {
                focusrHelper.writeFile(groupObject["baseDir"] + groupObject["outputFile"], groupObject["criticalCss"]);
            }
            else {
                if (global["debug"]) {
                    body.innerHTML = focusrHelper.insertDebugBox(body);
                }
                var resultHTML = window.document.documentElement.outerHTML;
                focusrHelper.writeFile(groupObject["baseDir"] + groupObject["outputFile"], resultHTML);
            }
            focusrHelper.logMessage(groupObject["groupID"], "File '" + groupObject["baseDir"] + groupObject["outputFile"] + "' generated", 1);

            if (global["runningGroups"] === 0) {
                focusrHelper.outro();
            }
        }
    });
}

function transformRulesRelativeToOutput(rules, unmodifiedCssUrl) {
    for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule["rules"] !== undefined) {
            transformRulesRelativeToOutput(rule["rules"], unmodifiedCssUrl);
        }
        else if (rule["declarations"] !== undefined) {
            for (var j = 0; j < rule["declarations"].length; j++) {
                var declaration = rule["declarations"][j];
                var regexPattern = new RegExp("url\\(.*\\..*\\)");
                var regexResult = regexPattern.exec(declaration["value"]);
                if (regexResult !== null) {
                    var originalValue = regexResult.toString();
                    var prefix = "";
                    regexResult = regexResult.toString().substring(4, regexResult.toString().length - 1);
                    if (regexResult.indexOf("'") === 0 || regexResult.indexOf('"') === 0) {
                        prefix = regexResult.substring(0, 1);
                        regexResult = regexResult.substring(1, regexResult.length - 1);
                    }
                    if (!focusrHelper.isRemoteUrl(regexResult)) {
                        var newPath = "url(" + prefix + urlparse.resolve(unmodifiedCssUrl, regexResult) + prefix + ")";
                        declaration["value"] = declaration["value"].replace(originalValue, newPath);
                    }

                }
            }
        }
    }
}

//-----------------------
// MAIN CALL
//-----------------------

if (process.argv[2] !== undefined) {
    focus(process.argv[2], process.argv[3], process.argv[4]);
}
else {
    fs.readFile("config.json", 'utf8', function (err, data) {
        if (!err) {
            parseConfig(JSON.parse(data));
        }
        else {
            console.log("Config file can not be opened");
        }
    });
}

exports.focus = focus;