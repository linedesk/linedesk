# The four images that the staging deploy builds (deploy-staging.yml), in one `depot bake -f docker-bake.hcl`: in
# parallel on one Depot builder, sharing their stages and the Depot project's layer cache. The workflow sets REGISTRY
# and TAG. Self-hosting and local builds don't use this file (docker-compose.yml).
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
