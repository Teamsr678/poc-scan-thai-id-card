package main

import (
	"golang-backend/controller"

	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "http://localhost:5173")
		c.Header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
		c.Next()
	})
	r.POST("/upload", controller.UploadHandler)
	r.Run(":8080")
}
