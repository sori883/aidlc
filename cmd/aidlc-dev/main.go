package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sori883/aidlc/internal/distribution/stage2poc"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "stage2-poc" {
		fmt.Fprintln(os.Stderr, "Usage: aidlc-dev stage2-poc [--target all|GOOS-GOARCH] [--output DIR] [--skip-parity]")
		os.Exit(1)
	}
	flags := flag.NewFlagSet("stage2-poc", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	target := flags.String("target", "all", "target to build; default builds all five targets")
	output := flags.String("output", "build/stage2-poc", "ignored evidence output directory")
	skipParity := flags.Bool("skip-parity", false, "skip the Bun differential comparison")
	if err := flags.Parse(os.Args[2:]); err != nil || flags.NArg() != 0 {
		os.Exit(1)
	}
	repoRoot, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	outputDir := *output
	if !filepath.IsAbs(outputDir) {
		outputDir = filepath.Join(repoRoot, outputDir)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	report, err := stage2poc.Run(ctx, stage2poc.Options{
		RepoRoot: repoRoot, OutputDir: outputDir, Target: *target, SkipParity: *skipParity,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
