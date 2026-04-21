import { getContentDirections } from "./lib/services/content-decision.service";

const result = getContentDirections({
  category: "fitness",
  businessModel: "local_service",
  hasContentActivity: false,
});

console.log(result);