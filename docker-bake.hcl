# The four images that the maintainers' staging and production deploys build, in one
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
  # api and agent: every file time in their layers set to SOURCE_DATE_EPOCH (the workflows pass 0), so the same files
  # always give the same layers, also after a build without cache; the server then does not pull and unpack the
  # unchanged node_modules again (the agent's is 160 MB compressed; LIN-570). Not web and proxy: Caddy's ETags and
  # Last-Modified use the file times. `--push` adds push=true to this output.
  output = [contains(["api", "agent"], service) ? "type=image,rewrite-timestamp=true" : "type=image"]
}
