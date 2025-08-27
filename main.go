package main

import (
	"golang-backend/controller"

	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	r.POST("/upload", controller.UploadHandler)
	r.Run(":8080")
}
