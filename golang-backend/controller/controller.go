package controller

import (
	"fmt"
	"golang-backend/service"
	"net/http"

	"github.com/gin-gonic/gin"
)

func UploadHandler(c *gin.Context) {
	image, _, err := c.Request.FormFile("file")
	if err != nil {
		c.String(http.StatusBadRequest, "failed to get file")
		return
	}

	result, err := service.Scan(image)
	if err != nil {
		fmt.Println("Error scanning image:", err)
		c.String(http.StatusInternalServerError, "failed to scan image")
		return
	}

	c.String(http.StatusOK, *result)
}
