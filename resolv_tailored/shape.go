package resolv

import (
	"math"
)

type Shape interface {
	// Intersection tests to see if a Shape intersects with the other given Shape. dx and dy are delta movement variables indicating
	// movement to be applied before the intersection check (thereby allowing you to see if a Shape would collide with another if it
	// were in a different relative location). If an Intersection is found, a ContactSet will be returned, giving information regarding
	// the intersection.
	Intersection(dx, dy float64, other Shape) *ContactSet
	// Bounds returns the top-left and bottom-right points of the Shape.
	Bounds() (Vector, Vector)
	// Position returns the X and Y position of the Shape.
	Position() (float64, float64)
	// SetPosition allows you to place a Shape at another location.
	SetPosition(x, y float64)
	// Clone duplicates the Shape.
	Clone() Shape
}

// A Line is a helper shape used to determine if two ConvexPolygon lines intersect; you can't create a Line to use as a Shape.
// Instead, you can create a ConvexPolygon, specify two points, and set its Closed value to false.
type Line struct {
	Start, End Vector
}

func NewLine(x, y, x2, y2 float64) *Line {
	return &Line{
		Start: Vector{x, y},
		End:   Vector{x2, y2},
	}
}

func (line *Line) Project(axis Vector) Vector {
	return line.Vector().Scale(axis.Dot(line.Start.Sub(line.End)))
}

func (line *Line) Normal() Vector {
	dy := line.End[1] - line.Start[1]
	dx := line.End[0] - line.Start[0]
	return Vector{dy, -dx}.Unit()
}

func (line *Line) Vector() Vector {
	return line.End.Clone().Sub(line.Start).Unit()
}

// IntersectionPointsLine returns the intersection point of a Line with another Line as a Vector. If no intersection is found, it will return nil.
func (line *Line) IntersectionPointsLine(other *Line) Vector {

	det := (line.End[0]-line.Start[0])*(other.End[1]-other.Start[1]) - (other.End[0]-other.Start[0])*(line.End[1]-line.Start[1])

	if det != 0 {

		// MAGIC MATH; the extra + 1 here makes it so that corner cases (literally, lines going through corners) works.

		// lambda := (float32(((line.Y-b.Y)*(b.X2-b.X))-((line.X-b.X)*(b.Y2-b.Y))) + 1) / float32(det)
		lambda := (((line.Start[1] - other.Start[1]) * (other.End[0] - other.Start[0])) - ((line.Start[0] - other.Start[0]) * (other.End[1] - other.Start[1])) + 1) / det

		// gamma := (float32(((line.Y-b.Y)*(line.X2-line.X))-((line.X-b.X)*(line.Y2-line.Y))) + 1) / float32(det)
		gamma := (((line.Start[1] - other.Start[1]) * (line.End[0] - line.Start[0])) - ((line.Start[0] - other.Start[0]) * (line.End[1] - line.Start[1])) + 1) / det

		if (0 < lambda && lambda < 1) && (0 < gamma && gamma < 1) {

			// Delta
			dx := line.End[0] - line.Start[0]
			dy := line.End[1] - line.Start[1]

			// dx, dy := line.GetDelta()

			return Vector{line.Start[0] + (lambda * dx), line.Start[1] + (lambda * dy)}
		}

	}

	return nil

}

// IntersectionPointsCircle returns a slice of Vectors, each indicating the intersection point. If no intersection is found, it will return an empty slice.
func (line *Line) IntersectionPointsCircle(circle *Circle) []Vector {

	points := []Vector{}

	cp := Vector{circle.X, circle.Y}
	lStart := line.Start.Sub(cp)
	lEnd := line.End.Sub(cp)
	diff := lEnd.Sub(lStart)

	a := diff[0]*diff[0] + diff[1]*diff[1]
	b := 2 * ((diff[0] * lStart[0]) + (diff[1] * lStart[1]))
	c := (lStart[0] * lStart[0]) + (lStart[1] * lStart[1]) - (circle.Radius * circle.Radius)

	det := b*b - (4 * a * c)

	if det < 0 {
		// Do nothing, no intersections
	} else if det == 0 {

		t := -b / (2 * a)

		if t >= 0 && t <= 1 {
			points = append(points, Vector{line.Start[0] + t*diff[0], line.Start[1] + t*diff[1]})
		}

	} else {

		t := (-b + math.Sqrt(det)) / (2 * a)

		// We have to ensure t is between 0 and 1; otherwise, the collision points are on the circle as though the lines were infinite in length.
		if t >= 0 && t <= 1 {
			points = append(points, Vector{line.Start[0] + t*diff[0], line.Start[1] + t*diff[1]})
		}
		t = (-b - math.Sqrt(det)) / (2 * a)
		if t >= 0 && t <= 1 {
			points = append(points, Vector{line.Start[0] + t*diff[0], line.Start[1] + t*diff[1]})
		}

	}

	return points

}

type ConvexPolygon struct {
	Points *RingBuffer
	X, Y   float64
	Closed bool
}

// NewConvexPolygon creates a new convex polygon from the provided set of X and Y positions of 2D points (or vertices). Should generally be ordered clockwise,
// from X and Y of the first, to X and Y of the last. For example: NewConvexPolygon(0, 0, 10, 0, 10, 10, 0, 10) would create a 10x10 convex
// polygon square, with the vertices at {0,0}, {10,0}, {10, 10}, and {0, 10}.
func NewConvexPolygon(points ...float64) *ConvexPolygon {

	cp := &ConvexPolygon{
		Points: NewRingBuffer(6), // I don't expected more points to be coped with in this particular game
		Closed: true,
	}

	cp.AddPoints(points...)

	return cp
}

func (cp *ConvexPolygon) GetPointByOffset(offset int32) Vector {
	if cp.Points.Cnt <= offset {
		return nil
	}
	return cp.Points.GetByFrameId(cp.Points.StFrameId + offset).(Vector)
}

func (cp *ConvexPolygon) Clone() Shape {

	newPoly := NewConvexPolygon()
	newPoly.X = cp.X
	newPoly.Y = cp.Y
	for i := int32(0); i < cp.Points.Cnt; i++ {
		newPoly.Points.Put(cp.GetPointByOffset(i))
	}
	newPoly.Closed = cp.Closed
	return newPoly
}

// AddPoints allows you to add points to the ConvexPolygon with a slice or selection of float64s, with each pair indicating an X or Y value for
// a point / vertex (i.e. AddPoints(0, 1, 2, 3) would add two points - one at {0, 1}, and another at {2, 3}).
func (cp *ConvexPolygon) AddPoints(vertexPositions ...float64) {
	for v := 0; v < len(vertexPositions); v += 2 {
		// "resolv.Vector" is an alias of "[]float64", thus already a pointer type
		cp.Points.Put(Vector{vertexPositions[v], vertexPositions[v+1]})
	}
}

func (cp *ConvexPolygon) UpdateAsRectangle(x, y, w, h float64) bool {
	// This function might look ugly but it's a fast in-place update!
	if 4 != cp.Points.Cnt {
		panic("ConvexPolygon not having exactly 4 vertices to form a rectangle#1!")
	}
	for i := int32(0); i < cp.Points.Cnt; i++ {
		thatVec := cp.GetPointByOffset(i)
		if nil == thatVec {
			panic("ConvexPolygon not having exactly 4 vertices to form a rectangle#2!")
		}
		switch i {
		case 0:
			thatVec[0] = x
			thatVec[1] = y
		case 1:
			thatVec[0] = x + w
			thatVec[1] = y
		case 2:
			thatVec[0] = x + w
			thatVec[1] = y + h
		case 3:
			thatVec[0] = x
			thatVec[1] = y + h
		}
	}
	return true
}

// Lines returns a slice of transformed Lines composing the ConvexPolygon.
func (cp *ConvexPolygon) Lines() []*Line {

	vertices := cp.Transformed()
	linesCnt := len(vertices)
	if !cp.Closed {
		linesCnt -= 1
	}
	lines := make([]*Line, linesCnt)

	for i := 0; i < linesCnt; i++ {
		start, end := vertices[i], vertices[0]
		if i < len(vertices)-1 {
			end = vertices[i+1]
		}
		line := NewLine(start[0], start[1], end[0], end[1])
		lines[i] = line
	}

	return lines

}

// Transformed returns the ConvexPolygon's points / vertices, transformed according to the ConvexPolygon's position.
func (cp *ConvexPolygon) Transformed() []Vector {
	transformed := make([]Vector, cp.Points.Cnt)
	for i := int32(0); i < cp.Points.Cnt; i++ {
		point := cp.GetPointByOffset(i)
		transformed[i] = Vector{point[0] + cp.X, point[1] + cp.Y}
	}
	return transformed
}

// Bounds returns two Vectors, comprising the top-left and bottom-right positions of the bounds of the
// ConvexPolygon, post-transformation.
func (cp *ConvexPolygon) Bounds() (Vector, Vector) {

	transformed := cp.Transformed()

	topLeft := Vector{transformed[0][0], transformed[0][1]}
	bottomRight := topLeft.Clone()

	for i := 0; i < len(transformed); i++ {

		point := transformed[i]

		if point[0] < topLeft[0] {
			topLeft[0] = point[0]
		} else if point[0] > bottomRight[0] {
			bottomRight[0] = point[0]
		}

		if point[1] < topLeft[1] {
			topLeft[1] = point[1]
		} else if point[1] > bottomRight[1] {
			bottomRight[1] = point[1]
		}

	}
	return topLeft, bottomRight
}

// Position returns the position of the ConvexPolygon.
func (cp *ConvexPolygon) Position() (float64, float64) {
	return cp.X, cp.Y
}

// SetPosition sets the position of the ConvexPolygon. The offset of the vertices compared to the X and Y position is relative to however
// you initially defined the polygon and added the vertices.
func (cp *ConvexPolygon) SetPosition(x, y float64) {
	cp.X = x
	cp.Y = y
}

// SetPositionVec allows you to set the position of the ConvexPolygon using a Vector. The offset of the vertices compared to the X and Y
// position is relative to however you initially defined the polygon and added the vertices.
func (cp *ConvexPolygon) SetPositionVec(vec Vector) {
	cp.X = vec.X()
	cp.Y = vec.Y()
}

// Move translates the ConvexPolygon by the designated X and Y values.
func (cp *ConvexPolygon) Move(x, y float64) {
	cp.X += x
	cp.Y += y
}

// MoveVec translates the ConvexPolygon by the designated Vector.
func (cp *ConvexPolygon) MoveVec(vec Vector) {
	cp.X += vec.X()
	cp.Y += vec.Y()
}

// Center returns the transformed Center of the ConvexPolygon.
func (cp *ConvexPolygon) Center() Vector {

	pos := Vector{0, 0}

	vertices := cp.Transformed()
	for _, v := range vertices {
		pos.Add(v)
	}

	denom := float64(len(vertices))
	pos[0] /= denom
	pos[1] /= denom

	return pos

}

// Project projects (i.e. flattens) the ConvexPolygon onto the provided axis.
func (cp *ConvexPolygon) Project(axis Vector) Projection {
	axis = axis.Unit()
	vertices := cp.Transformed()
	min := axis.Dot(Vector{vertices[0][0], vertices[0][1]})
	max := min
	for i := 1; i < len(vertices); i++ {
		p := axis.Dot(Vector{vertices[i][0], vertices[i][1]})
		if p < min {
			min = p
		} else if p > max {
			max = p
		}
	}
	return Projection{min, max}
}

// SATAxes returns the axes of the ConvexPolygon for SAT intersection testing.
func (cp *ConvexPolygon) SATAxes() []Vector {
	lines := cp.Lines()
	axes := make([]Vector, len(lines))
	for i, line := range lines {
		axes[i] = line.Normal()
	}
	return axes

}

// PointInside returns if a Point (a Vector) is inside the ConvexPolygon.
func (polygon *ConvexPolygon) PointInside(point Vector) bool {

	pointLine := NewLine(point[0], point[1], point[0]+999999999999, point[1])

	contactCount := 0

	for _, line := range polygon.Lines() {

		if line.IntersectionPointsLine(pointLine) != nil {
			contactCount++
		}

	}

	return contactCount == 1
}

type ContactSet struct {
	Points []Vector // Slice of Points indicating contact between the two Shapes.
	MTV    Vector   // Minimum Translation Vector; this is the vector to move a Shape on to move it outside of its contacting Shape.
	Center Vector   // Center of the Contact set; this is the average of all Points contained within the Contact Set.
}

func NewContactSet() *ContactSet {
	return &ContactSet{
		Points: []Vector{},
		MTV:    Vector{0, 0},
		Center: Vector{0, 0},
	}
}

// LeftmostPoint returns the left-most point out of the ContactSet's Points slice. If the Points slice is empty somehow, this returns nil.
func (cs *ContactSet) LeftmostPoint() Vector {

	var left Vector

	for _, point := range cs.Points {

		if left == nil || point[0] < left[0] {
			left = point
		}

	}

	return left

}

// RightmostPoint returns the right-most point out of the ContactSet's Points slice. If the Points slice is empty somehow, this returns nil.
func (cs *ContactSet) RightmostPoint() Vector {

	var right Vector

	for _, point := range cs.Points {

		if right == nil || point[0] > right[0] {
			right = point
		}

	}

	return right

}

// TopmostPoint returns the top-most point out of the ContactSet's Points slice. If the Points slice is empty somehow, this returns nil.
func (cs *ContactSet) TopmostPoint() Vector {

	var top Vector

	for _, point := range cs.Points {

		if top == nil || point[1] < top[1] {
			top = point
		}

	}

	return top

}

// BottommostPoint returns the bottom-most point out of the ContactSet's Points slice. If the Points slice is empty somehow, this returns nil.
func (cs *ContactSet) BottommostPoint() Vector {

	var bottom Vector

	for _, point := range cs.Points {

		if bottom == nil || point[1] > bottom[1] {
			bottom = point
		}

	}

	return bottom

}

// Intersection tests to see if a ConvexPolygon intersects with the other given Shape. dx and dy are delta movement variables indicating
// movement to be applied before the intersection check (thereby allowing you to see if a Shape would collide with another if it
// were in a different relative location). If an Intersection is found, a ContactSet will be returned, giving information regarding
// the intersection.
func (cp *ConvexPolygon) Intersection(dx, dy float64, other Shape) *ContactSet {

	contactSet := NewContactSet()

	ogX := cp.X
	ogY := cp.Y
	cp.X += dx
	cp.Y += dy

	if circle, isCircle := other.(*Circle); isCircle {

		for _, line := range cp.Lines() {
			contactSet.Points = append(contactSet.Points, line.IntersectionPointsCircle(circle)...)
		}

	} else if poly, isPoly := other.(*ConvexPolygon); isPoly {

		for _, line := range cp.Lines() {

			for _, otherLine := range poly.Lines() {

				if point := line.IntersectionPointsLine(otherLine); point != nil {
					contactSet.Points = append(contactSet.Points, point)
				}

			}

		}

	}

	if len(contactSet.Points) > 0 {

		for _, point := range contactSet.Points {
			contactSet.Center = contactSet.Center.Add(point)
		}

		contactSet.Center[0] /= float64(len(contactSet.Points))
		contactSet.Center[1] /= float64(len(contactSet.Points))

		if mtv := cp.calculateMTV(contactSet, other); mtv != nil {
			contactSet.MTV = mtv
		}

	} else {
		contactSet = nil
	}

	// If dx or dy aren't 0, then the MTV will be greater to compensate; this adjusts the vector back.
	if contactSet != nil && (dx != 0 || dy != 0) {
		deltaMagnitude := Vector{dx, dy}.Magnitude()
		ogMagnitude := contactSet.MTV.Magnitude()
		contactSet.MTV = contactSet.MTV.Unit().Scale(ogMagnitude - deltaMagnitude)
	}

	cp.X = ogX
	cp.Y = ogY

	return contactSet

}

// calculateMTV returns the MTV, if possible, and a bool indicating whether it was possible or not.
func (cp *ConvexPolygon) calculateMTV(contactSet *ContactSet, otherShape Shape) Vector {

	delta := Vector{0, 0}

	smallest := Vector{math.MaxFloat64, 0}

	switch other := otherShape.(type) {

	case *ConvexPolygon:

		for _, axis := range cp.SATAxes() {
			if !cp.Project(axis).Overlapping(other.Project(axis)) {
				return nil
			}

			overlap := cp.Project(axis).Overlap(other.Project(axis))

			if smallest.Magnitude() > overlap {
				smallest = axis.Scale(overlap)
			}

		}

		for _, axis := range other.SATAxes() {

			if !cp.Project(axis).Overlapping(other.Project(axis)) {
				return nil
			}

			overlap := cp.Project(axis).Overlap(other.Project(axis))

			if smallest.Magnitude() > overlap {
				smallest = axis.Scale(overlap)
			}

		}
		// Removed support of "Circle" to remove dependency of "sort" module
	}

	delta[0] = smallest[0]
	delta[1] = smallest[1]

	return delta
}

// ContainedBy returns if the ConvexPolygon is wholly contained by the other shape provided.
func (cp *ConvexPolygon) ContainedBy(otherShape Shape) bool {

	switch other := otherShape.(type) {

	case *ConvexPolygon:

		for _, axis := range cp.SATAxes() {
			if !cp.Project(axis).IsInside(other.Project(axis)) {
				return false
			}
		}

		for _, axis := range other.SATAxes() {
			if !cp.Project(axis).IsInside(other.Project(axis)) {
				return false
			}
		}

	}

	return true
}

// NewRectangle returns a rectangular ConvexPolygon with the vertices in clockwise order. In actuality, an AABBRectangle should be its own
// "thing" with its own optimized Intersection code check.
func NewRectangle(x, y, w, h float64) *ConvexPolygon {
	return NewConvexPolygon(
		x, y,
		x+w, y,
		x+w, y+h,
		x, y+h,
	)
}

type Circle struct {
	X, Y, Radius float64
}

// NewCircle returns a new Circle, with its center at the X and Y position given, and with the defined radius.
func NewCircle(x, y, radius float64) *Circle {
	circle := &Circle{
		X:      x,
		Y:      y,
		Radius: radius,
	}
	return circle
}

func (circle *Circle) Clone() Shape {
	return NewCircle(circle.X, circle.Y, circle.Radius)
}

// Bounds returns the top-left and bottom-right corners of the Circle.
func (circle *Circle) Bounds() (Vector, Vector) {
	return Vector{circle.X - circle.Radius, circle.Y - circle.Radius}, Vector{circle.X + circle.Radius, circle.Y + circle.Radius}
}

// Intersection tests to see if a Circle intersects with the other given Shape. dx and dy are delta movement variables indicating
// movement to be applied before the intersection check (thereby allowing you to see if a Shape would collide with another if it
// were in a different relative location). If an Intersection is found, a ContactSet will be returned, giving information regarding
// the intersection.
func (circle *Circle) Intersection(dx, dy float64, other Shape) *ContactSet {

	var contactSet *ContactSet

	ox := circle.X
	oy := circle.Y

	circle.X += dx
	circle.Y += dy

	// here

	switch shape := other.(type) {
	case *ConvexPolygon:
		// Maybe this would work?
		contactSet = shape.Intersection(-dx, -dy, circle)
		if contactSet != nil {
			contactSet.MTV = contactSet.MTV.Scale(-1)
		}
	case *Circle:

		contactSet = NewContactSet()

		contactSet.Points = circle.IntersectionPointsCircle(shape)

		if len(contactSet.Points) == 0 {
			return nil
		}

		contactSet.MTV = Vector{circle.X - shape.X, circle.Y - shape.Y}
		dist := contactSet.MTV.Magnitude()
		contactSet.MTV = contactSet.MTV.Unit().Scale(circle.Radius + shape.Radius - dist)

		for _, point := range contactSet.Points {
			contactSet.Center = contactSet.Center.Add(point)
		}

		contactSet.Center[0] /= float64(len(contactSet.Points))
		contactSet.Center[1] /= float64(len(contactSet.Points))

		// if contactSet != nil {
		// 	contactSet.MTV[0] -= dx
		// 	contactSet.MTV[1] -= dy
		// }

		// contactSet.MTV = Vector{circle.X - shape.X, circle.Y - shape.Y}
	}

	circle.X = ox
	circle.Y = oy

	return contactSet
}

// Move translates the Circle by the designated X and Y values.
func (circle *Circle) Move(x, y float64) {
	circle.X += x
	circle.Y += y
}

// MoveVec translates the Circle by the designated Vector.
func (circle *Circle) MoveVec(vec Vector) {
	circle.X += vec.X()
	circle.Y += vec.Y()
}

// SetPosition sets the center position of the Circle using the X and Y values given.
func (circle *Circle) SetPosition(x, y float64) {
	circle.X = x
	circle.Y = y
}

// SetPosition sets the center position of the Circle using the Vector given.
func (circle *Circle) SetPositionVec(vec Vector) {
	circle.X = vec.X()
	circle.Y = vec.Y()
}

// Position() returns the X and Y position of the Circle.
func (circle *Circle) Position() (float64, float64) {
	return circle.X, circle.Y
}

// PointInside returns if the given Vector is inside of the circle.
func (circle *Circle) PointInside(point Vector) bool {
	return point.Sub(Vector{circle.X, circle.Y}).Magnitude() <= circle.Radius
}

// IntersectionPointsCircle returns the intersection points of the two circles provided.
func (circle *Circle) IntersectionPointsCircle(other *Circle) []Vector {

	d := math.Sqrt(math.Pow(other.X-circle.X, 2) + math.Pow(other.Y-circle.Y, 2))

	if d > circle.Radius+other.Radius || d < math.Abs(circle.Radius-other.Radius) || d == 0 && circle.Radius == other.Radius {
		return nil
	}

	a := (math.Pow(circle.Radius, 2) - math.Pow(other.Radius, 2) + math.Pow(d, 2)) / (2 * d)
	h := math.Sqrt(math.Pow(circle.Radius, 2) - math.Pow(a, 2))

	x2 := circle.X + a*(other.X-circle.X)/d
	y2 := circle.Y + a*(other.Y-circle.Y)/d

	return []Vector{
		{x2 + h*(other.Y-circle.Y)/d, y2 - h*(other.X-circle.X)/d},
		{x2 - h*(other.Y-circle.Y)/d, y2 + h*(other.X-circle.X)/d},
	}

}

type Projection struct {
	Min, Max float64
}

// Overlapping returns whether a Projection is overlapping with the other, provided Projection. Credit to https://www.sevenson.com.au/programming/sat/
func (projection Projection) Overlapping(other Projection) bool {
	return projection.Overlap(other) > 0
}

// Overlap returns the amount that a Projection is overlapping with the other, provided Projection. Credit to https://dyn4j.org/2010/01/sat/#sat-nointer
func (projection Projection) Overlap(other Projection) float64 {
	return math.Min(projection.Max, other.Max) - math.Max(projection.Min, other.Min)
}

// IsInside returns whether the Projection is wholly inside of the other, provided Projection.
func (projection Projection) IsInside(other Projection) bool {
	return projection.Min >= other.Min && projection.Max <= other.Max
}
