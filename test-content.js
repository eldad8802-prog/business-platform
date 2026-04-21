"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var content_decision_service_1 = require("./lib/services/content-decision.service");
var result = (0, content_decision_service_1.getContentDirections)({
    category: "fitness",
    businessModel: "local_service",
    hasContentActivity: false,
});
console.log(result);
