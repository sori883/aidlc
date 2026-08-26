package contract

import "fmt"

// StageID identifies one Stage in the fixed vNext workflow.
type StageID string

const (
	Stage00 StageID = "ST-00"
	Stage01 StageID = "ST-01"
	Stage02 StageID = "ST-02"
	Stage03 StageID = "ST-03"
	Stage04 StageID = "ST-04"
	Stage05 StageID = "ST-05"
	Stage06 StageID = "ST-06"
	Stage07 StageID = "ST-07"
	Stage08 StageID = "ST-08"
	Stage09 StageID = "ST-09"
)

// OrderedStageIDs is the immutable workflow order enforced by validators.
var OrderedStageIDs = [...]StageID{
	Stage00,
	Stage01,
	Stage02,
	Stage03,
	Stage04,
	Stage05,
	Stage06,
	Stage07,
	Stage08,
	Stage09,
}

// ParseStageID rejects values outside the fixed ten-Stage catalog.
func ParseStageID(value string) (StageID, error) {
	for _, stageID := range OrderedStageIDs {
		if value == string(stageID) {
			return stageID, nil
		}
	}
	return "", fmt.Errorf("must be one of: ST-00, ST-01, ST-02, ST-03, ST-04, ST-05, ST-06, ST-07, ST-08, ST-09")
}

// Valid reports whether stageID belongs to the fixed ten-Stage workflow.
func (stageID StageID) Valid() bool {
	_, err := ParseStageID(string(stageID))
	return err == nil
}
