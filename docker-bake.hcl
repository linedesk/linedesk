# The four images that the staging and production deploys build (deploy-staging.yml, deploy-production.yml), in one
# `depot bake -f docker-bake.hcl`: in parallel on one Depot builder, sharing their stages and the Depot project's layer
# cache (one project each). The workflows set REGISTRY and TAG. Self-hosting and local builds don't use this file (docker-compose.yml).
variable "REGISTRY" {
  default = "linedesk"
}

variable "TAG" {
  default = "local"
}

group "default" {
  targets = ["images"]
}

target "images" {
  name   = service
  matrix = { service = ["api", "web", "proxy", "agent"] }
  target = service
  tags   = ["${REGISTRY}/linedesk-${service}:${TAG}"]
}
