package main

import (
	"io"
	"os"

	"github.com/sori883/aidlc/internal/cli"
)

func run(args []string, stdout, stderr io.Writer) int {
	return cli.Run(args, stdout, stderr)
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}
