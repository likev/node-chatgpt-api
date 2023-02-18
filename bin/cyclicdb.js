import CyclicDb from "@cyclic.sh/dynamodb"
const db = CyclicDb("fragile-seal-cuffCyclicDB")

const animals = db.collection("animals");
// get an item at key "leo" from collection animals
let item = await animals.delete("leo");
console.log(item);



// create an item in collection with key "leo"
let leo = await animals.set("leo", {
    type: "cat2",
    color: "orange2",
    ob: {
        ad: [3,4]
    }
})

// get an item at key "leo" from collection animals
let item2 = await animals.get("leo")
console.log(item2)

console.log(item2.props.type)
//process.exit(0)
// create an item in collection with key "leo"
let leo3 = await animals.set("leo", {ob: [5,3]})

// get an item at key "leo" from collection animals
let item3 = await animals.get("leo")
console.log(item3)

process.exit(0)