import subprocess


def test_version() -> None:
    result = subprocess.run(["achilles", "--version"], capture_output=True, text=True)
    assert result.returncode == 0
    assert result.stdout.strip() == "achilles 0.1.0"
