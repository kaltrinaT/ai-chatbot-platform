output "role_arn" {
  description = "The role_arn of the platform-control-plane profile described at the top of main.tf."
  value       = aws_iam_role.control_plane.arn
}
